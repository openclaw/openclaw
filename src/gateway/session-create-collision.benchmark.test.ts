import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

it.runIf(process.env.OPENCLAW_SESSION_COLLISION_BENCH === "1")(
  "measures explicit incognito collisions across 4,428 durable rows",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const agentId = "main";
      const storePath = resolveSessionStorePathCore(undefined, { agentId });
      const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
      const { db } = openOpenClawAgentDatabase({ agentId, path: target.path });
      const key = "agent:main:dashboard:incognito-collision";
      const insert = db.prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      );
      db.exec("BEGIN");
      for (let index = 0; index < 4428; index++) {
        const sessionId = `fixture-${index}`;
        const entry = {
          sessionId,
          updatedAt: index + 1,
          label: `Session ${index}`,
          ...(index >= 2300 ? { archivedAt: 1 } : {}),
        };
        insert.run(
          index === 0 ? key : `agent:main:dashboard:fixture-${index}`,
          sessionId,
          JSON.stringify(entry),
          entry.updatedAt,
        );
      }
      db.exec("UPDATE session_nodes SET entry_valid = 1; COMMIT");
      // Exclude first-admission validation; measure repeated requests on an admitted store.
      listSessionEntriesReadOnly({ agentId, storePath, projection: "list", clone: false });
      const invoke = () =>
        createGatewaySession({ cfg: {}, agentId, key, incognito: true, commandSource: "test" });
      expect(await invoke()).toMatchObject({
        ok: false,
        error: { message: "incognito is immutable and requires a new session key" },
      });
      for (let index = 0; index < 5; index++) {
        await invoke();
      }
      const samples = [];
      for (let sample = 0; sample < 7; sample++) {
        const cpu = process.threadCpuUsage();
        const start = performance.now();
        for (let index = 0; index < 10; index++) {
          await invoke();
        }
        const elapsedCpu = process.threadCpuUsage(cpu);
        samples.push({
          ms: (performance.now() - start) / 10,
          cpuMs: (elapsedCpu.user + elapsedCpu.system) / 10_000,
        });
      }
      console.log(
        JSON.stringify({
          rows: 4428,
          calls: 70,
          samples,
          medianMs: samples.map((s) => s.ms).toSorted((a, b) => a - b)[3],
          medianCpuMs: samples.map((s) => s.cpuMs).toSorted((a, b) => a - b)[3],
        }),
      );
    });
  },
);
