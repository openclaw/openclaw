import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as canaryProcess from "../../infra/update-candidate-canary-process.js";
import { createCanaryProcessFixture } from "../../infra/update-candidate-canary.test-support.js";
import * as rehearsals from "../../infra/update-candidate-rehearsal.js";
import { createUpdateRun, getUpdateRunAsync } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createGatewayRestartDeadline } from "../daemon-cli/restart-health-deadline.js";
import type { UpdateCommandOptions } from "./shared.js";
import { validateUpdateCandidateWithProgress } from "./update-command-candidate-validation.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
afterEach(() => vi.restoreAllMocks());

async function prepareValidation(stall?: "doctor" | "lint") {
  const root = await fs.realpath(dirs.make("candidate-budget-"));
  const rehearsal = await createCanaryProcessFixture(
    root,
    `import { createServer } from "node:http";
const args = process.argv.slice(2);
if (args.includes("--fix")) {
  if (${JSON.stringify(stall === "doctor")}) setInterval(() => {}, 1000);
} else if (args.includes("--lint")) {
  if (${JSON.stringify(stall === "lint")}) setInterval(() => {}, 1000);
  else console.log(JSON.stringify({ok: true, checksRun: 1, findings: [], warnings: []}));
} else if (args.includes("plugins")) {
  console.log(JSON.stringify({plugins: [], diagnostics: []}));
} else if (args.includes("gateway")) {
  createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({status: "started", ready: true}));
  }).listen(Number(args.at(-1)), "127.0.0.1");
}
`,
  );
  rehearsal.cleanupDirectories = [rehearsal.stateDir];
  const snapshot = vi.spyOn(rehearsals, "prepareUpdateCandidateRehearsal");
  snapshot.mockResolvedValue(rehearsal);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "source") };
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
    env,
  };
  const guards = createUpdateCommandExecutionGuards({ run }, root);
  const validate = () =>
    validateUpdateCandidateWithProgress(
      {
        root,
        config: {},
        env,
        assertCurrent: guards.assertCurrent,
        writeOptions: guards.captureWriteOptions(),
      },
      { opts: { json: true }, progress: {} },
      run,
    );
  return { validate, snapshot, rehearsal, run };
}

it("preserves each size-aware check budget after a long snapshot and Doctor", async () => {
  const { validate, snapshot, rehearsal, run } = await prepareValidation();
  const wallClock = Date.now.bind(Date);
  const monotonicClock = performance.now.bind(performance);
  let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => wallClock() + elapsed);
  vi.spyOn(performance, "now").mockImplementation(() => monotonicClock() + elapsed);
  // The snapshot owner supplies measured capacity. No multi-gigabyte fixture is needed.
  rehearsal.snapshotCapacity.sqliteBytes = 2 * 1024 ** 3;
  snapshot.mockImplementation(async () => {
    elapsed += 900_000;
    return rehearsal;
  });
  const launch = canaryProcess.launchCanary;
  vi.spyOn(canaryProcess, "launchCanary").mockImplementation((params) => {
    const running = launch(params);
    if (params.args.includes("doctor")) {
      elapsed += 1_000_000;
    }
    return running;
  });

  const result = await validate();

  expect(result).toMatchObject({ status: "ok", phase: "readiness" });
  expect(result.durationMs).toBeGreaterThanOrEqual(2_900_000);
  expect(result.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "candidate-doctor", exitCode: 0 }),
      expect.objectContaining({ name: "candidate-doctor-lint", exitCode: 0 }),
      expect.objectContaining({ name: "candidate-state-cleanup", exitCode: 0 }),
    ]),
  );
  const saved = await getUpdateRunAsync(run.runId, { env: run.env });
  expect(saved?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ step: "candidate-doctor-lint", status: "in_progress" }),
      expect.objectContaining({ step: "candidate-state-cleanup", status: "completed" }),
    ]),
  );
  await expect(fs.access(rehearsal.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["doctor", "lint"] as const)(
  "settles a silent %s child when the inherited overall deadline expires",
  async (phase) => {
    const { validate, rehearsal, run } = await prepareValidation(phase);
    const clock = performance.now.bind(performance);
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock() + elapsed);
    const failure = new Error("explicit overall update deadline");
    const deadline = createGatewayRestartDeadline({ timeoutMs: 10_000, timeoutError: failure });
    run.deadline = deadline;
    const launch = canaryProcess.launchCanary;
    let interrupted: ReturnType<typeof launch> | undefined;
    const spawned: string[][] = [];
    vi.spyOn(canaryProcess, "launchCanary").mockImplementation((params) => {
      spawned.push(params.args);
      const running = launch(params);
      if (params.args.includes(phase === "doctor" ? "--fix" : "--lint")) {
        interrupted = running;
        running.child.once("spawn", () => {
          elapsed += 10_001;
          deadline.remainingMs();
        });
      }
      return running;
    });
    let validation: ReturnType<typeof validate> | undefined;
    try {
      await expect(deadline.run(() => (validation = validate()))).rejects.toBe(failure);
      await expect(validation).rejects.toBe(failure);
      await deadline.cleanup;
      expect(deadline.cleanupStatus).toBe("confirmed");
      expect(interrupted?.hasExited()).toBe(true);
      expect(spawned.some((args) => args.includes("plugins") || args.includes("gateway"))).toBe(
        false,
      );
      // Revoked progress authority must not authorize disposable-state removal.
      await expect(fs.access(rehearsal.stateDir)).resolves.toBeUndefined();
    } finally {
      deadline.dispose();
    }
  },
);
