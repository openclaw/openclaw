import assert from "node:assert/strict";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { createSubagentStoreRunFixture } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { readAllSubagentRunsInWorker } from "../../agents/subagents/registry/subagent-registry.store.read.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { OpenClawStateReadCommand } from "../../state/openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s subagent registry",
  (engine) => {
    const fixture = useMixedAgentPair(engine, engine);

    it("persists child runs through the worker and cold-reads full, maintenance, and session projections", async () => {
      const database = withEngineStoreAdmission(() => openOpenClawStateDatabase());
      const storePath = path.join(fixture.root, "agents", "main", "agent", "openclaw-agent.sqlite");
      const runs = new Map<string, SubagentRunRecord>();
      const records = ([undefined, "parent"] as const).map((completionTarget, index) =>
        createSubagentStoreRunFixture({
          runId: `child-${index}`,
          childSessionKey: `agent:main:subagent:child-${index}`,
          requesterSessionKey: "agent:main:parent",
          requesterDisplayKey: "parent",
          controllerSessionKey: "agent:main:controller",
          requesterStorePath: storePath,
          controllerStorePath: storePath,
          task: index === 0 ? "retained task" : "retained task with escaped NUL \0",
          createdAt: 100 + index,
          completion: { required: true, resultText: "retained child result" },
          delivery: { status: "pending" },
          ...(completionTarget ? { completionTarget } : {}),
        }),
      );
      const runIds = records.map((entry) => entry.runId);
      const postimages = new Map(records.map((entry) => [entry.runId, entry]));
      await mutateSubagentRuns(runIds, () => ({ value: undefined, postimages }), { runs });
      const before = await readAllSubagentRunsInWorker(captureOpenClawStateWorkerContext());
      expect([...before]).toMatchObject([...postimages]);

      await closeOpenClawStateDatabaseByPathAsync(database.path);
      withEngineStoreAdmission(() => openOpenClawStateDatabase());
      const context = captureOpenClawStateWorkerContext();
      const options = { path: database.path, env: process.env };
      const read = <C extends OpenClawStateReadCommand>(command: C) =>
        executeExistingOpenClawStateRead(options, command, { context, current: true });
      expect(await readAllSubagentRunsInWorker(context)).toEqual(before);

      const maintenance = await read({ type: "subagents.runs", scope: { kind: "maintenance" } });
      assert(maintenance?.ok && maintenance.type === "subagents.runs");
      const sessions = await read({ type: "subagents.sessionList" });
      assert(sessions?.ok && sessions.type === "subagents.sessionList" && "runs" in sessions);
      for (const [projection, fields] of [
        [maintenance, { execution: { status: "terminal", endedAt: 250 } }],
        [
          sessions,
          {
            requesterStorePath: storePath,
            controllerStorePath: storePath,
            controllerSessionKey: "agent:main:controller",
            execution: { status: "terminal", outcome: { status: "ok" } },
          },
        ],
      ] as const) {
        expect([...projection.runs.keys()]).toEqual(runIds);
        for (const record of projection.runs.values()) {
          expect(record).toMatchObject({ ...fields, delivery: { status: "pending" } });
          expect(record).not.toHaveProperty("task");
          expect(record).not.toHaveProperty("completion");
        }
      }

      const selected = await read({
        type: "subagents.runs",
        scope: { kind: "ids", runIds: [runIds[1]!] },
      });
      assert(selected?.ok && selected.type === "subagents.runs");
      expect([...selected.runs]).toEqual([[runIds[1], before.get(runIds[1]!)]]);
    });
  },
);
