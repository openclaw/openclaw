import { randomUUID } from "node:crypto";
import { expect, it, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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

export function registerMetadataCallerCases(
  createPersonalMetadataFixture: () => PersonalMetadataFixture,
) {
  it.each([
    "foreign admin",
    "unidentified admin",
    "anonymous",
    "synthetic owner",
    "forged locator",
  ] as const)(
    "rejects a personal draft preview from %s before projecting credentials",
    async (caller) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const { owner, client, authProfileId, readChatMetadata, request } =
          createPersonalMetadataFixture();
        client.connect.scopes = ["operator.admin"];
        let requestedProfile = authProfileId;
        if (caller === "foreign admin") {
          const other = ensureProfileForEmail("metadata-other@example.test");
          client.authenticatedUserProfile = {
            profileId: other.id,
            displayName: other.displayName,
            hasAvatar: false,
            updatedAt: other.updatedAt,
          };
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

        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
        expect(readChatMetadata).not.toHaveBeenCalled();
      });
    },
  );
}

export function registerMetadataRevocationCases(
  createPersonalMetadataFixture: () => PersonalMetadataFixture,
) {
  it.each(["disconnect", "role loss", "abort"] as const)(
    "rejects a personal draft preview after %s during the metadata read",
    async (loss) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const { client, clients, authProfileId, config, metadata, readChatMetadata, request } =
          createPersonalMetadataFixture();
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
        const respond = await pending;
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
      });
    },
  );
}
