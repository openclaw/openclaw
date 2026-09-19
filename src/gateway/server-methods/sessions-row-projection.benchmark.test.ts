import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

it("benchmarks current lists over 4,000 resident session candidates", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
    const now = Date.now();
    for (let index = 0; index < 4_000; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:benchmark-${index}` },
        { sessionId: `benchmark-${index}`, updatedAt: now - index, label: `Session ${index}` },
      );
    }
    const context = requestContext(cfg);
    const clients = Array.from({ length: 6 }, (_, index) => identifiedClient(`viewer-${index}`));
    const request = { configuredAgentsOnly: true, limit: 100 };
    await listSessions({ client: clients[0]!, context, request });
    const cpuMs: number[] = [];
    for (let index = 0; index < 21; index++) {
      const sessionKey = "agent:main:benchmark-0";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: "benchmark-0", updatedAt: now + index, label: `Changed ${index}` },
      );
      emitSessionsChanged(context, { sessionKey, agentId: "main", reason: "benchmark" });
      await setImmediate();
      const started = process.threadCpuUsage();
      const result = await listSessions({
        client: clients[index % clients.length]!,
        context,
        request,
      });
      const elapsed = process.threadCpuUsage(started);
      if (index > 0) {
        cpuMs.push((elapsed.user + elapsed.system) / 1_000);
      }
      expect(result.totalCount).toBe(4_000);
      expect(result.sessions).toHaveLength(100);
      expect(result.sessions[0]?.label).toBe(`Changed ${index}`);
    }
    cpuMs.sort((left, right) => left - right);
    console.log(
      JSON.stringify({
        fixtureRows: 4_000,
        viewers: 6,
        calls: cpuMs.length,
        p50CpuMs: cpuMs[Math.floor(cpuMs.length / 2)],
      }),
    );
  });
});
