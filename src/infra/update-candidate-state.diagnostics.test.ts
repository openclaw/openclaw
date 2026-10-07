import { expect, it } from "vitest";
import {
  createUpdateStateInspectionDiagnostics,
  formatUpdateStateInspectionError,
  UPDATE_STATE_INSPECTION_PROGRESS_PREFIX,
} from "./update-candidate-state.diagnostics.js";
import { createUpdateErrorFact, normalizeUpdateFailureFacts } from "./update-failure-facts.js";

const privateRoot = "/synthetic/private operator";
const stateDir = `${privateRoot}/.openclaw`;
const env = { HOME: privateRoot, OPENCLAW_STATE_DIR: stateDir };

it.each(["SIGILL", "SIGABRT", "SIGTERM"])(
  "reports the active worker step for %s without blaming storage",
  (signal) => {
    const source = `${stateDir}/agents/main/agent/openclaw-agent.sqlite`;
    const diagnostics = createUpdateStateInspectionDiagnostics({
      operation: "State schema inspection",
      phase: "pre-migration database backup",
      paths: [source],
    });
    const phase = "loading sqlite-vec for source validation";
    diagnostics.onOutputChunk(
      Buffer.from(
        `${UPDATE_STATE_INSPECTION_PROGRESS_PREFIX}${JSON.stringify({ phase, path: source })}\n`,
      ),
      "stderr",
    );
    const message = diagnostics.failure(undefined, `signal, signal ${signal}`).message;
    expect(message).toContain(signal);
    expect(message).toContain(`during ${phase} for ${source}`);
    expect(message).toContain("terminated by a signal");
    expect(message).not.toMatch(/Check access|free space|storage performance/);
  },
);

it.each(["", "EACCES: "])("does not promote private worker prose (%j)", (prefix) => {
  const detail = `${prefix}Inspection failed for synthetic-private-tenant at '${privateRoot}/source.sqlite'`;
  const diagnostics = createUpdateStateInspectionDiagnostics({
    operation: "State schema inspection",
    phase: "shared database discovery",
    paths: [`${stateDir}/state/openclaw.sqlite`],
  });
  diagnostics.onOutputChunk(
    Buffer.from(formatUpdateStateInspectionError(new Error(detail))),
    "stderr",
  );
  const error = diagnostics.failure(diagnostics.stderr(), "exit");
  const fact = createUpdateErrorFact("git update", error, env);

  expect(error.message).toContain(detail);
  expect(fact.message).toContain(prefix ? "EACCES" : "[redacted-diagnostic]");
  expect(fact.message).not.toMatch(/synthetic-private-tenant|private operator|source.sqlite/);
});

it.each([
  { code: "EACCES", nested: true },
  { code: "ERR_MODULE_NOT_FOUND", nested: true },
  { code: "ERR_MODULE_NOT_FOUND", nested: false },
  { code: "ERR_SQLITE_ERROR", nested: true, warning: true },
  { code: "SQLITE_BUSY", nested: true, warning: true },
])("retains $code from the real worker formatter (nested=$nested)", ({ code, nested, warning }) => {
  const cause = Object.assign(new Error(`Unable to open '${privateRoot}/o'brien/worker.sqlite'`), {
    code,
  });
  const error = nested
    ? new Error(`Inspection failed for '${privateRoot}/source.sqlite'`, { cause })
    : cause;
  const diagnostics = createUpdateStateInspectionDiagnostics({
    operation: "State schema inspection",
    phase: "shared database discovery",
    paths: [`${stateDir}/state/openclaw.sqlite`],
  });
  diagnostics.onOutputChunk(
    Buffer.from(
      `${warning ? "ExperimentalWarning: SQLite is experimental\n" : ""}${formatUpdateStateInspectionError(error)}`,
    ),
    "stderr",
  );
  const fact = createUpdateErrorFact(
    "git update",
    diagnostics.failure(diagnostics.stderr(), "exit"),
    env,
  );

  expect(fact.message).toContain(code);
  expect(fact.message).not.toMatch(/private operator|brien|worker.sqlite|source.sqlite/);
  expect(fact.message?.length).toBeLessThanOrEqual(200);
});

it("retains only a recognized cause from multiline worker output", () => {
  const diagnostics = createUpdateStateInspectionDiagnostics({
    operation: "State schema inspection",
    phase: "shared database discovery",
    paths: [`${stateDir}/state/openclaw.sqlite`],
  });
  diagnostics.onOutputChunk(
    Buffer.from(
      `Inspection failed\nCaused by: EACCES: permission denied '${privateRoot}/state.sqlite'`,
    ),
    "stderr",
  );
  const fact = createUpdateErrorFact(
    "git update",
    diagnostics.failure(diagnostics.stderr(), "exit"),
    env,
  );

  expect(fact.message).toContain("EACCES");
  expect(fact.message).not.toContain("private operator");
});

it.each(["\n", "\r", "\u2028", "\u2029"])(
  "does not promote private filename text after a false cause marker (%j)",
  (separator) => {
    const error = new Error(
      `Unable to open '${privateRoot}/source${separator}Caused by: private-customer.sqlite'`,
    );
    const diagnostics = createUpdateStateInspectionDiagnostics({
      operation: "State schema inspection",
      phase: "shared database discovery",
      paths: [`${stateDir}/state/openclaw.sqlite`],
    });
    diagnostics.onOutputChunk(Buffer.from(formatUpdateStateInspectionError(error)), "stderr");
    const fact = createUpdateErrorFact(
      "git update",
      diagnostics.failure(diagnostics.stderr(), "exit"),
      env,
    );

    expect(fact.message).not.toMatch(/private operator|private-customer|Caused by/);
    expect(fact.message).toContain("[redacted-path]");
  },
);

it("retains the missing-output explanation in the update failure fact", () => {
  const diagnostics = createUpdateStateInspectionDiagnostics({
    operation: "State schema inspection",
    phase: "shared database discovery",
    paths: [`${stateDir}/state/openclaw.sqlite`],
  });
  const fact = createUpdateErrorFact("git update", diagnostics.failure(undefined, "exit"), env);

  expect(fact.message).toContain("Worker exited without diagnostic output");
  expect(fact.message).not.toContain("private operator");
});

it.each([
  { operation: "State schema inspection", source: `${stateDir}/state/openclaw.sqlite` },
  {
    operation: "State schema inventory",
    source: String.raw`C:\Users\Private Operator\state.sqlite`,
  },
  {
    operation: "State schema inspection",
    source: String.raw`\\private-server\private-share\state.sqlite`,
  },
  { operation: "State schema inspection", source: `${stateDir}/agent's snapshot.sqlite` },
  {
    operation: "State snapshot",
    source: `${stateDir}/private plugin/state.sqlite`,
    progress: true,
  },
  { operation: "State schema inventory", source: `${stateDir}/state.sqlite`, multiple: true },
] as const)("retains the $operation cause across redacted reporting for $source", (testCase) => {
  const diagnostics = createUpdateStateInspectionDiagnostics({
    operation: testCase.operation,
    phase: "shared database discovery",
    paths:
      "multiple" in testCase ? [testCase.source, `${stateDir}/other.sqlite`] : [testCase.source],
  });
  if ("progress" in testCase) {
    diagnostics.onOutputChunk(
      Buffer.from(
        `${UPDATE_STATE_INSPECTION_PROGRESS_PREFIX}${JSON.stringify({ phase: "plugin inventory", path: testCase.source })}\n`,
      ),
      "stderr",
    );
  }
  diagnostics.onOutputChunk(Buffer.from("EACCES: permission denied"), "stderr");

  const [fact] = normalizeUpdateFailureFacts(
    [createUpdateErrorFact("git update", diagnostics.failure(diagnostics.stderr(), "exit"), env)],
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
  const diagnostics = createUpdateStateInspectionDiagnostics({
    operation: "State schema inspection",
    phase: "shared database discovery",
    paths: [`${stateDir}/state/openclaw.sqlite`],
  });
  const fact = createUpdateErrorFact(
    "git update",
    diagnostics.failure(
      `EACCES: permission denied token=${secret}, open '${privateRoot}/o'brien/private-error.sqlite'`,
      "exit",
    ),
    env,
  );

  expect(fact.message).toContain("EACCES; Permission denied");
  expect(fact.message).not.toContain(secret);
  expect(fact.message).not.toContain("private operator");
  expect(fact.message).not.toContain("private-error");
  expect(fact.message).not.toContain("brien");
});
