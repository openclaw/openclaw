import { writeSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  createUpdateStateInspectionDiagnostics,
  createUpdateStateInspectionReporter,
  formatUpdateStateInspectionError,
  UPDATE_STATE_INSPECTION_PROGRESS_PREFIX,
} from "./update-candidate-state.diagnostics.js";
import { createUpdateErrorFact, normalizeUpdateFailureFacts } from "./update-failure-facts.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeSync: vi.fn(),
}));

const privateRoot = "/synthetic/private operator";
const stateDir = `${privateRoot}/.openclaw`;
const env = { HOME: privateRoot, OPENCLAW_STATE_DIR: stateDir };
const errorFact = (error: Error) => createUpdateErrorFact("git update", error, env);

function inspection(
  overrides: Partial<Parameters<typeof createUpdateStateInspectionDiagnostics>[0]> = {},
) {
  return createUpdateStateInspectionDiagnostics({
    operation: "State schema inspection",
    phase: "shared database discovery",
    paths: [`${stateDir}/state/openclaw.sqlite`],
    ...overrides,
  });
}

function workerFailure(error: Error, warning = "") {
  const diagnostics = inspection();
  diagnostics.onOutputChunk(
    Buffer.from(warning + formatUpdateStateInspectionError(error)),
    "stderr",
  );
  return diagnostics.failure(diagnostics.stderr(), "exit");
}

function progressChunk(value: object) {
  return Buffer.from(`${UPDATE_STATE_INSPECTION_PROGRESS_PREFIX}${JSON.stringify(value)}\n`);
}

afterEach(() => {
  vi.mocked(writeSync).mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["EAGAIN", "EWOULDBLOCK"])(
  "resumes legacy progress after repeated %s without spending its output budget",
  (code) => {
    const report = createUpdateStateInspectionReporter(true);
    const progress = { phase: "agent schema inspection", path: "/synthetic/agent.sqlite" };
    vi.mocked(writeSync).mockImplementation(() => {
      throw Object.assign(new Error("pipe full"), { code });
    });
    for (let index = 0; index < 1000; index++) {
      report(progress);
    }
    const output: string[] = [];
    vi.mocked(writeSync).mockImplementation((_fd, line) => {
      output.push(line);
      return Buffer.byteLength(line);
    });
    report(progress);
    expect(output).toEqual([
      `${UPDATE_STATE_INSPECTION_PROGRESS_PREFIX}${JSON.stringify(progress)}\n`,
    ]);
  },
);

it("delivers the legacy omission notice once after its pipe becomes writable", () => {
  const report = createUpdateStateInspectionReporter(true);
  const output: string[] = [];
  const omitted = `${UPDATE_STATE_INSPECTION_PROGRESS_PREFIX}${JSON.stringify({ phase: "schema inspection; detailed progress omitted" })}\n`;
  let blocked = true;
  vi.mocked(writeSync).mockImplementation((_fd, line) => {
    if (line === omitted && blocked) {
      throw Object.assign(new Error("pipe full"), { code: "EAGAIN" });
    }
    output.push(line);
    return Buffer.byteLength(line);
  });
  const progress = { phase: "agent schema inspection", path: "/synthetic/agent.sqlite" };
  for (let index = 0; index < 1000; index++) {
    report(progress);
  }
  expect(output.join("").length).toBeLessThanOrEqual(12_000);
  expect(output).not.toContain(omitted);
  blocked = false;
  report(progress);
  report(progress);
  expect(output.filter((line) => line === omitted)).toHaveLength(1);
  expect(output.at(-1)).toBe(omitted);
});

it("reports the active worker step for SIGILL without blaming storage", () => {
  const source = `${stateDir}/agents/main/agent/openclaw-agent.sqlite`;
  const diagnostics = inspection({
    phase: "pre-migration database backup",
    paths: [source],
  });
  const phase = "loading sqlite-vec for source validation";
  diagnostics.onOutputChunk(progressChunk({ phase, path: source }), "stderr");
  const message = diagnostics.failure(undefined, "signal, signal SIGILL").message;
  expect(message).toContain("SIGILL");
  expect(message).toContain(`during ${phase} for ${source}`);
  expect(message).toContain("terminated by a signal");
  expect(message).not.toMatch(/Check access|free space|storage performance/);
});

it.each([true, false])(
  "keeps the output-limit cause with warnings (retryAdvice=%s)",
  (retryAdvice) => {
    const error = inspection({ retryAdvice }).failure(
      "ExperimentalWarning: private diagnostic",
      "output-limit, signal SIGTERM",
    );
    expect(error).toHaveProperty("code", "output-limit");
    expect(error.message).toContain("Worker output exceeded its capture limit");
    expect(error.message).not.toMatch(/host crash|supervisor|free space|retry the update/);
    expect(error.message.includes("Report this update failure")).toBe(retryAdvice);
  },
);

it.each(["timeout", "no-output-timeout", "signal, signal SIGTERM"])(
  "does not misclassify %s as an output limit",
  (termination) => {
    const error = inspection().failure("ordinary worker warning", termination);
    expect(error).not.toHaveProperty("code", "output-limit");
    expect(error.message).toContain(`(${termination})`);
    expect(error.message).not.toContain("capture limit");
  },
);
it("streams valid snapshot progress separately from the diagnostic stderr budget", () => {
  const progress = vi.fn();
  const exceeded = vi.fn();
  const diagnostics = inspection({
    operation: "State snapshot",
    phase: "snapshot",
    paths: ["/private/copy"],
    onProgress: progress,
    stderrLimit: { bytes: 128, onExceeded: exceeded },
  });
  for (let copiedPages = 1; copiedPages <= 200; copiedPages++) {
    diagnostics.onOutputChunk(
      progressChunk({
        phase: "database snapshot",
        snapshot: { status: "copying", copiedPages, totalPages: 200, elapsedMs: copiedPages },
      }),
      "stderr",
    );
  }
  expect(progress).toHaveBeenCalledTimes(200);
  expect(diagnostics.stderr()).toBe("");
  expect(exceeded).not.toHaveBeenCalled();
  diagnostics.onOutputChunk(
    progressChunk({
      phase: "database snapshot",
      snapshot: { status: "copying", copiedPages: -1, totalPages: 200, elapsedMs: 200 },
    }),
    "stderr",
  );
  expect(progress).toHaveBeenCalledTimes(200);
  expect(diagnostics.stderr()).toContain("copiedPages");
});

it("does not promote private worker prose", () => {
  const detail = `Inspection failed for synthetic-private-tenant at '${privateRoot}/source.sqlite'`;
  const error = workerFailure(new Error(detail));
  const fact = errorFact(error);

  expect(error.message).toContain(detail);
  expect(fact.message).toContain("[redacted-diagnostic]");
  expect(fact.message).not.toMatch(/synthetic-private-tenant|private operator|source.sqlite/);
});

it("retains nested SQLITE_BUSY from the real worker formatter after a warning", () => {
  const cause = Object.assign(new Error(`Unable to open '${privateRoot}/o'brien/worker.sqlite'`), {
    code: "SQLITE_BUSY",
  });
  const error = new Error(`Inspection failed for '${privateRoot}/source.sqlite'`, { cause });
  const fact = errorFact(workerFailure(error, "ExperimentalWarning: SQLite is experimental\n"));

  expect(fact.message).toContain("SQLITE_BUSY");
  expect(fact.message).not.toMatch(/private operator|brien|worker.sqlite|source.sqlite/);
  expect(fact.message?.length).toBeLessThanOrEqual(200);
});

it("does not promote private filename text after a false cause marker", () => {
  const error = new Error(
    `Unable to open '${privateRoot}/source\nCaused by: private-customer.sqlite'`,
  );
  const fact = errorFact(workerFailure(error));

  expect(fact.message).not.toMatch(/private operator|private-customer|Caused by/);
  expect(fact.message).toContain("[redacted-path]");
});

it.each([
  {
    operation: "State schema inventory",
    paths: [String.raw`C:\Users\Private Operator\state.sqlite`],
  },
  {
    operation: "State schema inspection",
    paths: [String.raw`\\private-server\private-share\state.sqlite`],
  },
  {
    operation: "State schema inventory",
    paths: [`${stateDir}/state.sqlite`, `${stateDir}/other.sqlite`],
  },
] as const)("retains the $operation cause across redacted reporting for $paths", (testCase) => {
  const diagnostics = inspection(testCase);
  diagnostics.onOutputChunk(Buffer.from("EACCES: permission denied"), "stderr");

  const [fact] = normalizeUpdateFailureFacts(
    [errorFact(diagnostics.failure(diagnostics.stderr(), "exit"))],
    env,
  );

  expect(fact?.message).toContain("EACCES; Permission denied");
  expect(fact?.message).toContain("[redacted-path]");
  expect(fact?.message).not.toMatch(
    /private operator|Private Operator|private-server|private-share|agent's|private plugin/,
  );
  expect(fact?.message?.length).toBeLessThanOrEqual(200);
});

it("keeps credentials and private error paths redacted when preserving the worker cause", () => {
  const secret = ["sk", "synthetic", "diagnostic", "credential", "1234567890"].join("-");
  const diagnostics = inspection();
  const detail = `EACCES: permission denied token=${secret}, open '${privateRoot}/o'brien/private-error.sqlite'`;
  const fact = errorFact(diagnostics.failure(detail, "exit"));

  expect(fact.message).toContain("EACCES; Permission denied");
  expect(fact.message).not.toContain(secret);
  expect(fact.message).not.toMatch(/private operator|private-error|brien/);
});
