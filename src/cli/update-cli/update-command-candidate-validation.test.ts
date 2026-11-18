import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as canaryProcess from "../../infra/update-candidate-canary-process.js";
import {
  createCanaryProcessFixture,
  createCanaryStartupRuntimeFixture,
} from "../../infra/update-candidate-canary.test-support.js";
import { runDelegatedUpdateCandidateRehearsal } from "../../infra/update-candidate-delegated-rehearsal.js";
import * as rehearsals from "../../infra/update-candidate-rehearsal.js";
import { createUpdateRun, getUpdateRunAsync } from "../../infra/update-run-ledger.js";
import * as exec from "../../process/exec.js";
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

async function prepareValidation(stall?: "doctor" | "lint", fullIntegrityCheck = false) {
  const root = await fs.realpath(dirs.make("candidate-budget-"));
  const rehearsal = await createCanaryProcessFixture(
    root,
    `import { createServer } from "node:http";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("  --full-integrity-check  Verify copied state");
} else if (args.includes("--fix")) {
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
  const validate = (gatewayStartupRuntime?: string) =>
    validateUpdateCandidateWithProgress(
      {
        root,
        gatewayStartupRuntime,
        config: {},
        env,
        assertCurrent: guards.assertCurrent,
        writeOptions: guards.captureWriteOptions(),
      },
      { opts: { json: true, fullIntegrityCheck }, progress: {} },
      run,
    );
  return { root, validate, snapshot, rehearsal, run };
}

type CandidateBehavior = "passes" | "ends-without-result" | "abandons-a-check";

/**
 * Replaces the fixture entry with a candidate that rehearses itself: it reads the request,
 * waits for the updater's answer to each receipt, and marks when its announced check starts.
 */
async function installRehearsingCandidate(root: string, behavior: CandidateBehavior) {
  await fs.writeFile(
    path.join(root, "package.json"),
    '{"version":"2026.9.5","type":"module","openclaw":{"updateRehearsalProtocol":1}}',
  );
  const entry = path.join(root, "dist", "index.js");
  await fs.writeFile(
    entry,
    `import { spawn } from "node:child_process";
import fs from "node:fs";
import { createInterface } from "node:readline";
if (process.argv.includes("rehearse")) {
  const behavior = ${JSON.stringify(behavior)};
  const request = JSON.parse(fs.readFileSync(process.argv.at(-1), "utf8"));
  const emit = (event) => process.stderr.write("openclaw-update-rehearsal-event: " + JSON.stringify(event) + "\\n");
  const answers = createInterface({input: process.stdin})[Symbol.asyncIterator]();
  let seq = 0;
  const receipt = async (event) => {
    emit({...event, seq: ++seq});
    const answer = await answers.next();
    if (answer.done || !JSON.parse(answer.value).ok) process.exit(2);
  };
  const step = {name: "candidate-doctor", command: "doctor --fix", cwd: process.cwd(), durationMs: 1, exitCode: 0};
  await receipt({type: "progress", step: {step: "candidate-doctor", status: "in_progress", detail: "candidate protocol " + request.protocol}});
  fs.writeFileSync("check-started", "");
  if (behavior === "abandons-a-check") {
    const check = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {detached: true, stdio: "ignore"});
    check.unref();
    fs.writeFileSync("check.pid", String(check.pid));
    emit({type: "process", pid: check.pid});
    process.exit(1);
  }
  await receipt({type: "step", step});
  if (behavior === "passes") {
    console.log(JSON.stringify({protocol: 1, result: {status: "ok", phase: "readiness", durationMs: 1, logTail: [], steps: [step], candidateSchemaVersions: {state: 7, agent: 9}}}));
  }
  process.exitCode = behavior === "passes" ? 0 : 2;
  process.stdin.destroy();
}
${await fs.readFile(entry, "utf8")}`,
  );
}

it.each([
  ["accepts the candidate's own rehearsal", "passes"],
  ["runs its own rehearsal when the candidate's ends without a result", "ends-without-result"],
] as const)("%s", async (_name, behavior) => {
  const { root, validate, snapshot, run } = await prepareValidation();
  await installRehearsingCandidate(root, behavior);

  const result = await validate();

  expect(result).toMatchObject({ status: "ok", phase: "readiness" });
  if (behavior === "passes") {
    // The candidate's receipt reached the run ledger.
    const saved = await getUpdateRunAsync(run.runId, { env: run.env });
    expect(saved?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: "candidate-doctor", detail: "candidate protocol 1" }),
      ]),
    );
    // The updater did not snapshot or check anything itself, and says who did.
    expect(snapshot).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      "The candidate release ran its own update checks.",
    );
    expect(result.candidateSchemaVersions).toEqual({ state: 7, agent: 9 });
    expect(result.steps.map(({ name }) => name)).toEqual(["candidate-doctor"]);
  } else {
    expect(snapshot).toHaveBeenCalledOnce();
    expect(result.steps.map(({ name }) => name)).toContain("candidate-gateway-startup");
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Candidate rehearsal did not return a valid result (exit-2)"),
    );
  }
});

it("stops a real candidate before its announced check when a receipt is refused", async () => {
  const { root, run } = await prepareValidation();
  await installRehearsingCandidate(root, "passes");
  const refused = new Error("ledger writer lost");

  await expect(
    runDelegatedUpdateCandidateRehearsal({
      root,
      config: {},
      stateDir: path.join(root, "source"),
      env: run.env,
      onProgress: () => Promise.reject(refused),
    }),
  ).rejects.toBe(refused);

  await expect(fs.access(path.join(root, "check-started"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("stops a check that a crashed candidate left running", async () => {
  const { root, run } = await prepareValidation();
  await installRehearsingCandidate(root, "abandons-a-check");
  let abandoned: number | undefined;
  try {
    const outcome = await runDelegatedUpdateCandidateRehearsal({
      root,
      config: {},
      stateDir: path.join(root, "source"),
      env: run.env,
    });
    abandoned = Number(await fs.readFile(path.join(root, "check.pid"), "utf8"));

    expect(outcome).toMatchObject({ owner: "installed", fallbackReason: "exit-1" });
    // Signal 0 only probes: the check's own process group is gone before fallback starts.
    expect(() => process.kill(abandoned!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  } finally {
    if (abandoned) {
      try {
        process.kill(-abandoned, "SIGKILL");
      } catch {
        // Already stopped, which is the expected outcome.
      }
    }
  }
});

it("preserves each size-aware check budget after a long snapshot and Doctor", async () => {
  const { validate, snapshot, rehearsal, run } = await prepareValidation(undefined, true);
  const capabilityProbe = vi.spyOn(exec, "runExec");
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
  expect(capabilityProbe).toHaveBeenCalledWith(
    expect.any(String),
    expect.arrayContaining(["doctor", "--help"]),
    expect.objectContaining({ timeoutMs: 2_860_000 }),
  );
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

it.skipIf(process.platform === "win32").each([false, true])(
  "uses the service executable only for Gateway startup (incompatible=%s)",
  async (incompatible) => {
    const { root, validate, snapshot } = await prepareValidation();
    const { runner, dispatched } = await createCanaryStartupRuntimeFixture(root, incompatible);
    const launch = vi.spyOn(canaryProcess, "launchCanary");

    const result = await validate(runner);

    expect(snapshot).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nodeRunner: undefined }),
    );
    const calls = launch.mock.calls.map(([params]) => params);
    const startup = calls.filter(({ args }) => args.includes("gateway"));
    expect(startup).toHaveLength(1);
    expect(startup[0]?.nodeRunner).toBe(runner);
    expect(JSON.parse(await fs.readFile(dispatched, "utf8"))).toEqual(
      expect.arrayContaining(["--no-install", "gateway", "run"]),
    );
    const maintenance = calls.filter(({ args }) => !args.includes("gateway"));
    expect(maintenance.length).toBeGreaterThanOrEqual(5);
    expect(maintenance.every(({ nodeRunner }) => nodeRunner === undefined)).toBe(true);
    expect(result).toMatchObject({
      status: incompatible ? "error" : "ok",
      phase: incompatible ? "startup" : "readiness",
    });
    expect(result.steps.find(({ name }) => name === "candidate-gateway-startup")?.exitCode).toBe(
      incompatible ? 1 : 0,
    );
  },
);
