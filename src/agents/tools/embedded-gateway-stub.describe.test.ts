import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  createTestProjection,
  holdForeground,
  seedRow,
} from "../../gateway/session-row-projection.read-fixture.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  bindEmbeddedSessionRowProjection,
  createEmbeddedCallGateway,
} from "./embedded-gateway-stub.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

it("keeps embedded inventory unranked by shared pins and global descriptions bound to their agent", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {}, work: {} } } };
    setRuntimeConfigSnapshot(cfg);
    for (const agentId of ["main", "work"]) {
      seedRow(
        { agentId, key: "global" },
        { sessionId: `${agentId}-global`, updatedAt: 1, label: agentId, pinnedAt: 99 },
      );
    }
    const older = "agent:main:dashboard:older";
    const newer = "agent:main:dashboard:newer";
    seedRow({ agentId: "main", key: older }, { sessionId: "older", updatedAt: 10, pinnedAt: 99 });
    seedRow({ agentId: "main", key: newer }, { sessionId: "newer", updatedAt: 20 });
    using _ = holdForeground();
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    const unbind = bindEmbeddedSessionRowProjection(Promise.resolve(projection));
    const request = createEmbeddedCallGateway();
    try {
      const tool = createSessionsListTool({
        config: cfg,
        agentSessionKey: "agent:main:main",
        requesterAgentIdOverride: "main",
        callGateway: request,
        gatewayBacked: false,
        requireSessionReadOwner: true,
      });
      for (const pinned of [true, false]) {
        await expect(tool.execute("unsigned-filter", { pinned })).rejects.toThrow(
          /signed-in Gateway chat/,
        );
      }
      const inventory = await tool.execute("unsigned-list", { agentId: "main", limit: 2 });
      expect(Value.Check(tool.outputSchema!, inventory.details)).toBe(true);
      expect(inventory.details).toMatchObject({ sessions: [{ key: newer }, { key: older }] });
      for (const row of (inventory.details as { sessions: object[] }).sessions) {
        expect(row).not.toHaveProperty("pinned");
      }
      for (const agentId of ["work", "main"]) {
        const described = await request({
          method: "sessions.describe",
          params: { key: "global", agentId },
        });
        expect(described.session).toMatchObject({
          key: "global",
          agentId,
          sessionId: `${agentId}-global`,
          label: agentId,
        });
        const listed = await request<{ sessions: Array<{ key: string }> }>({
          method: "sessions.list",
          params: { agentId, includeGlobal: true },
        });
        const global = listed.sessions.find((row) => row.key === "global");
        expect(global).toMatchObject({ sessionId: `${agentId}-global` });
        for (const row of [described.session, global]) {
          expect(row).not.toHaveProperty("pinned");
          expect(row).not.toHaveProperty("pinnedAt");
        }
      }
      await expect(
        request({
          method: "sessions.describe",
          params: { key: "agent:work:missing", agentId: "work" },
        }),
      ).resolves.toEqual({ session: null });
      await expect(
        request({
          method: "sessions.describe",
          params: { key: "agent:work:missing", agentId: "main" },
        }),
      ).rejects.toThrow("does not match session key agent");
    } finally {
      unbind();
    }
  });
});
