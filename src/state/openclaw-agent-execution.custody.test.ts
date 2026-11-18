import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { createSessionWorkerExecutionSource } from "../config/sessions/session-worker-execution-source.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "./openclaw-agent-db-lifecycle.js";
import { createAgentCreationWitnessFixture } from "./openclaw-agent-execution.creation-fixture.test-support.js";
import { createWorkerSourceLookupGate } from "./openclaw-agent-execution.custody.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

const state = vi.hoisted(() => ({
  gate: undefined as ReturnType<typeof createWorkerSourceLookupGate> | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { observeWorkerSourceLookups } =
    await import("./openclaw-agent-execution.custody.test-support.js");
  return { ...actual, Worker: observeWorkerSourceLookups(actual.Worker, () => state.gate) };
});

it.each(["retarget", "retire during lookup"] as const)(
  "refuses a native mutation after source %s without blocking the host",
  async (change) => {
    const options = createAgentCreationWitnessFixture();
    const alias = path.join(options.env.OPENCLAW_STATE_DIR, "selected.sqlite");
    const replacement = path.join(options.env.OPENCLAW_STATE_DIR, "replacement.sqlite");
    state.gate = createWorkerSourceLookupGate(alias);
    const execution = captureOpenClawAgentDatabaseExecution(options);
    const base = createSessionWorkerExecutionSource(() => execution.assertCurrent(), "retired");
    await execution.prepare(base);
    fs.symlinkSync(options.path, alias);
    fs.writeFileSync(replacement, "synthetic replacement");
    const source = createSessionWorkerExecutionSource(() => execution.assertCurrent(), "retired", [
      {
        sourcePath: alias,
        candidates: [captureSessionStoreReadCandidate(alias)],
      },
    ]);
    const key = "agent:main:source-custody";
    let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
    let grants = 0;
    const admissions: ReturnType<typeof admission.createSqliteWorkerOperationAdmission>[] = [];
    const create = admission.createSqliteWorkerOperationAdmission;
    const spy = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) => {
        const retained = create((request, grant) => {
          if (request.stage === "transaction") {
            grants++;
            if (change === "retarget") {
              fs.unlinkSync(alias);
              fs.symlinkSync(replacement, alias);
            }
          }
          return callback(request, grant);
        }, attachment);
        admissions.push(retained);
        return retained;
      });
    if (change === "retire during lookup") {
      state.gate.arm();
    }
    const writing = execution.runExisting(source, (worker) =>
      worker.execute({
        type: "session.entries.replace",
        input: {
          expectedRows: new Map(),
          labelOwnerKeys: [],
          validationKeys: [key],
          replacements: [{ sessionKey: key, entry: { sessionId: "synthetic", updatedAt: 1 } }],
        },
      }),
    );
    const refused = expect(writing).rejects.toThrow();
    try {
      if (change === "retire during lookup") {
        await awaitGateBeforeSettlement(
          state.gate.entered,
          writing,
          "Native source lookup did not begin",
        );
        closing = closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
        expect(() => execution.assertCurrent()).toThrow();
        state.gate.release();
      }
      await refused;
      await closing;
      expect(grants).toBe(change === "retarget" ? 1 : 0);
      expect(admissions.length).toBeGreaterThan(0);
      // Closing creates another unused admission; the dispatched mutation owns the first.
      expect(admissions[0]?.settlement).toEqual({ kind: "completed" });
      expect(admissions.every((owner) => owner.committed === undefined)).toBe(true);
      expect(fs.readFileSync(replacement, "utf8")).toBe("synthetic replacement");
      const reader = captureOpenClawAgentDatabaseExecution(options);
      try {
        const rows = await reader.runExisting(
          createSessionWorkerExecutionSource(() => reader.assertCurrent(), "retired"),
          (worker) => worker.execute({ type: "session.entry.read", input: { sessionKeys: [key] } }),
        );
        expect(rows?.entries).toEqual([]);
      } finally {
        await reader.release();
      }
    } finally {
      state.gate.release();
      await writing.catch(() => {});
      await closing;
      spy.mockRestore();
      await execution.release();
      state.gate = undefined;
    }
  },
);

it("pins a first-created workspace across native transaction and commit grants", async () => {
  const options = createAgentCreationWitnessFixture();
  const workspace = path.join(options.env.OPENCLAW_STATE_DIR, "created-workspace");
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const base = createSessionWorkerExecutionSource(() => execution.assertCurrent(), "retired");
  await execution.prepare(base);
  const source = {
    ...base,
    workspaceEvidence: [
      { workspaceDir: workspace, canonical: workspace, root: [undefined, undefined] },
    ],
  };
  const key = "agent:main:workspace-custody";
  const create = admission.createSqliteWorkerOperationAdmission;
  const stages: string[] = [];
  using spy = vi
    .spyOn(admission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((callback, attachment) =>
      create((request, grant) => {
        if (request.stage === "transaction") {
          fs.mkdirSync(workspace);
          stages.push(request.stage);
        } else if (request.stage === "commit") {
          fs.renameSync(workspace, `${workspace}-original`);
          fs.mkdirSync(workspace);
          stages.push(request.stage);
        }
        return callback(request, grant);
      }, attachment),
    );
  try {
    await expect(
      execution.runExisting(source, (worker) =>
        worker.execute({
          type: "session.entries.replace",
          input: {
            expectedRows: new Map(),
            labelOwnerKeys: [],
            validationKeys: [key],
            replacements: [{ sessionKey: key, entry: { sessionId: "synthetic", updatedAt: 1 } }],
          },
        }),
      ),
    ).rejects.toThrow("Workspace filesystem changed");
    expect(stages).toEqual(["transaction", "commit"]);
    spy.mockRestore();
    const rows = await execution.runExisting(base, (worker) =>
      worker.execute({ type: "session.entry.read", input: { sessionKeys: [key] } }),
    );
    expect(rows?.entries).toEqual([]);
  } finally {
    spy.mockRestore();
    await execution.release();
  }
});
