import { afterEach, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { listSessions, requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("retains a frequently read sidebar baseline beyond 32 views and evicts the cold view", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const context = requestContext(rolePolicyConfig());
    const client = roleClient("view", "retention-reader");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    prepareGatewayRecipientProfile(client);
    const scope = { agentId: "main", sessionKey: "agent:main:retained-0" };
    for (let index = 0; index < 2; index++) {
      replaceSessionEntrySync(
        { ...scope, sessionKey: `agent:main:retained-${index}` },
        {
          sessionId: `retained-${index}`,
          label: `Row ${index}`,
          updatedAt: 2 - index,
          visibility: "shared",
        },
      );
    }
    const read = (limit: number, revision?: string) =>
      listSessions({
        context,
        client,
        acceptsSerializedJson: true,
        request: {
          agentId: "main",
          rowMode: "sidebar",
          limit,
          ifRowsRevision: revision && `delta:${revision}`,
        },
      });
    const release = retainSessionListForegroundWork();
    try {
      const cold = await read(2);
      const hot = await read(3);
      for (let limit = 4; limit < 284; limit++) {
        await read(limit);
        expect(
          (await read(3, hot.rowsRevision)).rowsUnchanged,
          `hot view after query ${limit}`,
        ).toBe(true);
      }
      expect((await read(2, cold.rowsRevision)).rowsUnchanged).toBeUndefined();
      replaceSessionEntrySync(scope, { ...loadSessionEntry(scope)!, label: "Changed" });
      expect(await read(3, hot.rowsRevision)).toMatchObject({
        rowsDelta: { baseRevision: hot.rowsRevision, order: [2, 1] },
      });
    } finally {
      getSessionRowProjection(context)?.dispose();
      release();
    }
  });
});
