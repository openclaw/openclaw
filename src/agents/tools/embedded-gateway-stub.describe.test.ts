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

it("keeps embedded global descriptions bound to their requested agent", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {}, work: {} } } };
    setRuntimeConfigSnapshot(cfg);
    for (const agentId of ["main", "work"]) {
      seedRow(
        { agentId, key: "global" },
        { sessionId: `${agentId}-global`, updatedAt: 1, label: agentId },
      );
    }
    using _ = holdForeground();
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    const unbind = bindEmbeddedSessionRowProjection(Promise.resolve(projection));
    const request = createEmbeddedCallGateway();
    try {
      for (const agentId of ["work", "main"]) {
        await expect(
          request({ method: "sessions.describe", params: { key: "global", agentId } }),
        ).resolves.toMatchObject({
          session: { key: "global", agentId, sessionId: `${agentId}-global`, label: agentId },
        });
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
