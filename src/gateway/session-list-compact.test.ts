import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import { SessionsListParamsSchema } from "../../packages/gateway-protocol/src/schema/sessions-list.js";
import { requestSessionListParams } from "../../ui/src/lib/sessions/session-requests.js";
import { createTestGatewayClient } from "../../ui/src/test-helpers/gateway-client.js";
import { replaceSessionEntrySync, loadSessionEntry } from "../config/sessions/session-accessor.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { serializeGatewayFrame } from "./serialized-json.js";
import { listSessions, requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import type { SessionsListResult } from "./session-utils.types.js";

afterEach(() => vi.restoreAllMocks());

it("reuses compact child rows through the real list handler and client decoder", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const context = requestContext(rolePolicyConfig());
    const client = roleClient("view", "compact-reader");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    prepareGatewayRecipientProfile(client);
    const parent = "agent:main:compact-parent";
    for (let index = 0; index < 18; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:subagent:compact-${index}` },
        {
          sessionId: `compact-${index}`,
          label: `Child ${index}`,
          updatedAt: now - index,
          spawnedBy: parent,
          visibility: "shared",
        },
      );
    }
    const query = { rowMode: "compact", spawnedBy: parent, limit: 200 } as const;
    const wire: SessionsListResult[] = [];
    const bytes: number[] = [];
    const request = vi.fn(async (_method: string, params?: unknown) => {
      const result = await listSessions({
        context,
        client,
        acceptsSerializedJson: true,
        request: Value.Decode(SessionsListParamsSchema, params),
      });
      const encoded = serializeGatewayFrame({
        type: "res",
        id: "compact",
        ok: true,
        payload: result,
      });
      const wireText = encoded.toString();
      bytes.push(Buffer.byteLength(wireText));
      const decoded = JSON.parse(wireText).payload as SessionsListResult;
      wire.push(decoded);
      return decoded;
    });
    const browser = createTestGatewayClient(request);
    const release = retainSessionListForegroundWork();
    try {
      const legacy = await request("sessions.list", query);
      expect(legacy.sessions).toHaveLength(18);
      expect(legacy.rowsRevision).toBeUndefined();
      const first = await requestSessionListParams(browser, query, () => true);
      expect(first?.sessions).toEqual(legacy.sessions);
      expect(first?.rowsRevision).toEqual(expect.any(String));
      const repeat = await requestSessionListParams(browser, query, () => true);
      expect(repeat?.sessions).toEqual(first?.sessions);
      expect(wire.at(-1)).toMatchObject({ rowsUnchanged: true, sessions: [] });
      const scope = { agentId: "main", sessionKey: "agent:main:subagent:compact-5" };
      replaceSessionEntrySync(scope, { ...loadSessionEntry(scope)!, label: "Renamed child" });
      const changed = await requestSessionListParams(browser, query, () => true);
      expect(wire.at(-1)?.sessions).toHaveLength(1);
      expect(wire.at(-1)?.rowsDelta?.baseRevision).toBe(first?.rowsRevision);
      expect(changed?.sessions.find((row) => row.key === scope.sessionKey)?.label).toBe(
        "Renamed child",
      );
      const full = await request("sessions.list", query);
      expect(changed?.sessions).toEqual(full.sessions);
      expect(bytes[2]!).toBeLessThan(bytes[0]! / 3);
      expect(bytes[3]!).toBeLessThan(bytes[4]! / 3);
      console.log(
        "COMPACT_LIST_BYTES",
        JSON.stringify({
          full: bytes[0],
          initial: bytes[1],
          unchanged: bytes[2],
          delta: bytes[3],
          changedFull: bytes[4],
        }),
      );
    } finally {
      release();
    }
  });
});
