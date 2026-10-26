import { assert, expect, it, type Mock } from "vitest";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { expectRpcError } from "./rpc-response.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

type PersonalMetadataFixture = {
  authProfileId: string;
  client: NonNullable<GatewayRequestHandlerOptions["client"]> & { connId: string };
  clients: Set<PersonalMetadataFixture["client"]>;
  metadata: Awaited<ReturnType<GatewayRequestContext["readChatMetadata"]>>;
  readChatMetadata: Mock<GatewayRequestContext["readChatMetadata"]>;
  request(params: Record<string, unknown>): Promise<Mock<RespondFn>>;
};

function registerCase(
  create: () => PersonalMetadataFixture,
  name: string,
  run: (fixture: PersonalMetadataFixture) => Promise<Mock<RespondFn>>,
) {
  it(name, () =>
    withOpenClawTestState({ layout: "state-only" }, async () => {
      const fixture = create();
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      expectRpcError(await run(fixture), { code: "FORBIDDEN" });
    }),
  );
}

export function registerMetadataCallerCases(create: () => PersonalMetadataFixture) {
  registerCase(
    create,
    "rejects a foreign administrator's personal draft preview before projecting credentials",
    async ({ client, authProfileId, readChatMetadata, request }) => {
      client.connect.scopes = ["operator.admin"];
      assert(client.authenticatedUserProfile);
      client.authenticatedUserProfile.profileId = ensureProfileForEmail(
        "metadata-other@example.test",
      ).id;
      const respond = await request({ agentId: "main", authProfileId });
      expect(readChatMetadata).not.toHaveBeenCalled();
      return respond;
    },
  );
}

export function registerMetadataRevocationCases(create: () => PersonalMetadataFixture) {
  registerCase(
    create,
    "rejects a personal draft preview disconnected during the metadata read",
    async ({ client, clients, authProfileId, metadata, readChatMetadata, request }) => {
      readChatMetadata.mockImplementationOnce(async () => {
        // Revoke after the read suspends, before its result reaches the response guard.
        await Promise.resolve();
        clients.delete(client);
        return metadata;
      });
      const respond = await request({ agentId: "main", authProfileId });
      expect(readChatMetadata).toHaveBeenCalledOnce();
      return respond;
    },
  );
}
