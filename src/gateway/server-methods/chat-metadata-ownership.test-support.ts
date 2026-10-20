import { randomUUID } from "node:crypto";
import { expect, it, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

type PersonalMetadataFixture = {
  owner: { id: string };
  authProfileId: string;
  client: NonNullable<GatewayRequestHandlerOptions["client"]> & { connId: string };
  clients: Set<PersonalMetadataFixture["client"]>;
  config: { gateway: { roles: { definitions: { reader: { scopes?: string[] } } } } };
  metadata: Awaited<ReturnType<GatewayRequestContext["readChatMetadata"]>>;
  readChatMetadata: Mock<GatewayRequestContext["readChatMetadata"]>;
  request: (
    params: Record<string, unknown>,
    overrides?: Partial<Pick<GatewayRequestHandlerOptions, "client" | "signal">>,
  ) => Promise<Mock<RespondFn>>;
};

function registerCases(
  create: () => PersonalMetadataFixture,
  cases: readonly string[],
  name: string,
  run: (fixture: PersonalMetadataFixture, kind: string) => Promise<Mock<RespondFn>>,
) {
  it.each(cases)(name, async (kind) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const fixture = create();
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      expect(await run(fixture, kind)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    });
  });
}

export function registerMetadataCallerCases(create: () => PersonalMetadataFixture) {
  registerCases(
    create,
    ["foreign admin", "unidentified admin", "anonymous", "synthetic owner", "forged locator"],
    "rejects a personal draft preview from %s before projecting credentials",
    async ({ owner, client, authProfileId, readChatMetadata, request }, caller) => {
      client.connect.scopes = ["operator.admin"];
      let requestedProfile = authProfileId;
      if (caller === "foreign admin") {
        const {
          id: profileId,
          displayName,
          updatedAt,
        } = ensureProfileForEmail("metadata-other@example.test");
        client.authenticatedUserProfile = { profileId, displayName, updatedAt, hasAvatar: false };
      } else if (caller === "unidentified admin") {
        delete client.authenticatedUserProfile;
      } else if (caller === "synthetic owner") {
        client.internal = { syntheticClient: true };
      } else if (caller === "forged locator") {
        requestedProfile = `personal:${owner.id}:${randomUUID()}`;
      }
      const respond = await request(
        { agentId: "main", authProfileId: requestedProfile },
        caller === "anonymous" ? { client: null } : {},
      );
      expect(readChatMetadata).not.toHaveBeenCalled();
      return respond;
    },
  );
}

export function registerMetadataRevocationCases(create: () => PersonalMetadataFixture) {
  registerCases(
    create,
    ["disconnect", "role loss", "abort"],
    "rejects a personal draft preview after %s during the metadata read",
    async (
      { client, clients, authProfileId, config, metadata, readChatMetadata, request },
      loss,
    ) => {
      const entered = createDeferred();
      const release = createDeferred();
      const abort = new AbortController();
      readChatMetadata.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return metadata;
      });
      const pending = request({ agentId: "main", authProfileId }, { signal: abort.signal });
      try {
        await Promise.race([entered.promise, pending]);
        expect(readChatMetadata).toHaveBeenCalledOnce();
        if (loss === "disconnect") {
          clients.delete(client);
        } else if (loss === "role loss") {
          config.gateway.roles.definitions.reader.scopes = [];
        } else {
          abort.abort();
        }
      } finally {
        release.resolve();
        await pending;
      }
      return pending;
    },
  );
}
