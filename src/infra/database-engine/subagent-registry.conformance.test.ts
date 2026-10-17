import assert from "node:assert/strict";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { readAllSubagentRunsInWorker } from "../../agents/subagents/registry/subagent-registry.store.read.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
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
      const records = ([undefined, "parent"] as const).map(
        (completionTarget, index): SubagentRunRecord => {
          const record: SubagentRunRecord = {
            runId: `child-${index}`,
            childSessionKey: `agent:main:subagent:child-${index}`,
            requesterSessionKey: "agent:main:parent",
            requesterDisplayKey: "parent",
            controllerSessionKey: "agent:main:controller",
            requesterStorePath: storePath,
            controllerStorePath: storePath,
            task: index === 0 ? "retained task" : "retained task with escaped NUL \0",
            cleanup: "keep",
            createdAt: 100 + index,
            execution: {
              status: "terminal",
              startedAt: 110,
              endedAt: 250,
              outcome: { status: "ok" },
            },
            completion: { required: true, resultText: "retained child result" },
            delivery: { status: "pending" },
          };
          if (completionTarget) {
            record.completionTarget = completionTarget;
          }
          return record;
        },
      );
      const runIds = records.map((entry) => entry.runId);
      await mutateSubagentRuns(
        runIds,
        () => ({
          value: undefined,
          postimages: new Map(records.map((entry) => [entry.runId, entry])),
        }),
        { runs },
      );
      const before = await readAllSubagentRunsInWorker(captureOpenClawStateWorkerContext());
      expect([...before.keys()]).toEqual(runIds);
      for (const record of records) {
        expect(before.get(record.runId)).toMatchObject(record);
      }

      await closeOpenClawStateDatabaseByPathAsync(database.path);
      withEngineStoreAdmission(() => openOpenClawStateDatabase());
      const context = captureOpenClawStateWorkerContext();
      const options = { path: database.path, env: process.env };
      expect(await readAllSubagentRunsInWorker(context)).toEqual(before);

      const maintenance = await executeExistingOpenClawStateRead(
        options,
        { type: "subagents.runs", scope: { kind: "maintenance" } },
        { context, current: true },
      );
      assert(maintenance?.ok && maintenance.type === "subagents.runs");
      expect([...maintenance.runs.keys()]).toEqual(runIds);
      for (const record of maintenance.runs.values()) {
        expect(record).toMatchObject({
          execution: { status: "terminal", endedAt: 250 },
          delivery: { status: "pending" },
        });
        expect(record).not.toHaveProperty("task");
        expect(record).not.toHaveProperty("completion");
      }

      const sessions = await executeExistingOpenClawStateRead(
        options,
        { type: "subagents.sessionList" },
        { context, current: true },
      );
      assert(sessions?.ok && sessions.type === "subagents.sessionList" && "runs" in sessions);
      expect([...sessions.runs.keys()]).toEqual(runIds);
      for (const record of sessions.runs.values()) {
        expect(record).toMatchObject({
          requesterStorePath: storePath,
          controllerStorePath: storePath,
          controllerSessionKey: "agent:main:controller",
          execution: { status: "terminal", outcome: { status: "ok" } },
          delivery: { status: "pending" },
        });
        expect(record).not.toHaveProperty("task");
        expect(record).not.toHaveProperty("completion");
      }

      const selected = await executeExistingOpenClawStateRead(
        options,
        { type: "subagents.runs", scope: { kind: "ids", runIds: [runIds[1]!] } },
        { context, current: true },
      );
      assert(selected?.ok && selected.type === "subagents.runs");
      expect([...selected.runs.keys()]).toEqual([runIds[1]]);
      expect(selected.runs.get(runIds[1]!)).toEqual(before.get(runIds[1]!));
    });
  },
);
