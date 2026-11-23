import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createUpdateStateInspectionDiagnostics,
  formatUpdateStateInspectionError,
} from "./update-candidate-state.diagnostics.js";
import { findUpdateCaptureSpaceError, UpdateCaptureSpaceError } from "./update-capture-space.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { UPDATE_STATE_INSPECTION_PROGRESS_PREFIX } from "./update-state-inspection-protocol.js";

beforeEach(() => {
  vi.spyOn(fs, "writeSync").mockReturnValue(0);
});

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
  vi.useRealTimers();
  vi.restoreAllMocks();
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
it("preserves measured capture capacity through a wrapped worker refusal", () => {
  const cause = new UpdateCaptureSpaceError(`Backup refused near ${privateRoot}`, {
    requiredBytes: 83886080,
    availableBytes: 12345,
  });
  const failure = workerFailure(
    new Error("Capture failed", { cause }),
    "ExperimentalWarning: SQLite\n",
  );
  expect(findUpdateCaptureSpaceError(failure)?.capacity).toEqual({
    requiredBytes: 83886080,
    availableBytes: 12345,
  });
});

it.each(["output-limit", "signal, signal SIGTERM"])(
  "does not replace %s with an earlier capacity diagnostic",
  (termination) => {
    const diagnostics = inspection();
    diagnostics.onOutputChunk(
      Buffer.from(
        formatUpdateStateInspectionError(
          new UpdateCaptureSpaceError("No space", {
            requiredBytes: 100,
            availableBytes: 1,
          }),
        ),
      ),
      "stderr",
    );
    expect(
      findUpdateCaptureSpaceError(diagnostics.failure(diagnostics.stderr(), termination)),
    ).toBeUndefined();
  },
);

it.each([
  "not-json",
  '{"requiredBytes":100,"availableBytes":-1}',
  '{"requiredBytes":100,"availableBytes":100}',
  '{"requiredBytes":"100","availableBytes":1}',
])("does not classify malformed or sufficient capture capacity: %s", (payload) => {
  const diagnostics = inspection();
  diagnostics.onOutputChunk(Buffer.from(`Update capture space: ${payload}\n`), "stderr");
  expect(
    findUpdateCaptureSpaceError(diagnostics.failure(diagnostics.stderr(), "exit")),
  ).toBeUndefined();
});

it("retains nested SQLITE_BUSY from the real worker formatter after a warning", () => {
  const secret = ["sk", "synthetic", "diagnostic", "credential", "1234567890"].join("-");
  const cause = Object.assign(
    new Error(`Unable to open token=${secret}, '${privateRoot}/o'brien/worker.sqlite'`),
    { code: "SQLITE_BUSY" },
  );
  const error = new Error(`Inspection failed for '${privateRoot}/source.sqlite'`, { cause });
  const failure = workerFailure(error, "ExperimentalWarning: SQLite is experimental\n");
  const fact = errorFact(failure);

  expect(failure.message).toContain(error.message);
  expect(fact.message).toContain("SQLITE_BUSY");
  expect(fact.message).not.toContain(secret);
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

  const fact = errorFact(diagnostics.failure(diagnostics.stderr(), "exit"));

  expect(fact?.message).toContain("EACCES; Permission denied");
  expect(fact?.message).toContain("[redacted-path]");
  expect(fact?.message).not.toContain("private operator");
  expect(fact?.message?.length).toBeLessThanOrEqual(200);
});
