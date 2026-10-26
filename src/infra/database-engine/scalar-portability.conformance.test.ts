import { describe, expect, it } from "vitest";
import { DebugProxyCaptureKernel } from "../../proxy-capture/store.kernel.js";
import type { CaptureSessionRecord } from "../../proxy-capture/types.js";
import {
  readSkillUsageInDatabase,
  recordSkillUsageInDatabase,
} from "../../skills/workshop/skill-usage.kernel.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} scalar portability`,
    () => {
      useMixedAgentPair(engine, engine);

      it("retains first and latest usage when skill events arrive out of order", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawStateDatabase();
          const skillFile = "/synthetic/skills/portability/SKILL.md";
          runOpenClawStateWriteTransaction(
            (writer) => {
              for (const [ts, agentId] of [
                [200, "initial"],
                [100, "earliest"],
                [300, "latest"],
                [150, "late-arrival"],
                [300, undefined],
              ] as const) {
                recordSkillUsageInDatabase(writer, {
                  skillFile,
                  skillKey: "portability",
                  skillName: "Portability",
                  skillSource: "synthetic",
                  agentId,
                  ts,
                });
              }
            },
            { database },
          );
          expect(readSkillUsageInDatabase(database, [skillFile])).toEqual([
            { skillFile, useCount: 5, lastUsedAtMs: 300 },
          ]);
          expect(
            database.db
              .prepare(
                "SELECT first_used_at_ms, last_used_at_ms, use_count, last_agent_id FROM skill_usage WHERE skill_file = ?",
              )
              .get(skillFile),
          ).toEqual({
            first_used_at_ms: 100,
            last_used_at_ms: 300,
            use_count: 5,
            last_agent_id: null,
          });
        }));

      it("retains the earliest capture start when repeated session writes update metadata", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawStateDatabase();
          const capture = new DebugProxyCaptureKernel({
            db: database.db,
            dbPath: database.path,
            blobDir: database.path,
            runWrite: (operation) => runOpenClawStateWriteTransaction(operation, { database }),
          });
          const session: CaptureSessionRecord = {
            id: "scalar-capture-session",
            startedAt: 200,
            mode: "implicit",
            sourceScope: "openclaw",
            sourceProcess: "synthetic-initial",
          };
          capture.upsertSession(session);
          capture.upsertSession({
            ...session,
            startedAt: 100,
            mode: "proxy",
            endedAt: 250,
            sourceProcess: "synthetic-earlier",
            proxyUrl: "http://synthetic.invalid",
          });
          capture.upsertSession({
            ...session,
            startedAt: 300,
            mode: "replacement",
            sourceProcess: "synthetic-latest",
          });
          expect(capture.listSessions()).toEqual([
            {
              id: session.id,
              startedAt: 100,
              endedAt: null,
              mode: "proxy",
              sourceProcess: "synthetic-latest",
              proxyUrl: null,
              eventCount: 0,
            },
          ]);
        }));
    },
  );
}
