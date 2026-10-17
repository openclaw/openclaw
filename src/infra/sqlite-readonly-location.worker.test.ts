import { afterEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { SqliteReadOnlyWorkerMode } from "./sqlite-readonly-worker-protocol.js";

const { prepare, prepareCopy, createToken, SourceChangedError } = vi.hoisted(() => ({
  prepare: vi.fn(),
  prepareCopy: vi.fn(),
  createToken: vi.fn(),
  SourceChangedError: class extends Error {},
}));
vi.mock("./sqlite-readonly-location.js", () => ({
  prepareSqliteReadOnlyLocationInProcess: prepare,
  prepareSqliteReadOnlyCopyInProcess: prepareCopy,
  SqliteSourceChangedError: SourceChangedError,
}));

vi.mock("./sqlite-snapshot-staging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sqlite-snapshot-staging.js")>()),
  createSqliteSnapshotStagingTokenSync: createToken,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  prepare.mockReset();
  prepareCopy.mockReset();
  createToken.mockReset();
  vi.resetModules();
});

async function readFailure(stdout: string, mode: SqliteReadOnlyWorkerMode, failure?: string) {
  const { readSqliteReadOnlyWorkerValue } = await import("./sqlite-readonly-worker-protocol.js");
  let received: unknown;
  try {
    readSqliteReadOnlyWorkerValue(
      {
        kind: "launched",
        stdout,
        stderr: "",
        status: 0,
        ...(failure === undefined ? {} : { failure }),
      },
      mode,
    );
  } catch (error) {
    received = error;
  }
  expect(received).toBeInstanceOf(Error);
  return received;
}

async function expectWorkerFailure(
  error: unknown,
  message: string,
  contention = false,
  mode: "sync" | "async" | "staging-create" | "staging-create-legacy" = "async",
  allocationRefused = false,
): Promise<void> {
  process.argv = [
    process.execPath,
    "sqlite-readonly-location.worker.ts",
    "--openclaw-sqlite-readonly-child",
    mode,
    "/synthetic/database.sqlite",
  ];
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  if (mode === "async") {
    prepare.mockRejectedValueOnce(error);
  } else {
    const producer = mode === "sync" ? prepareCopy : createToken;
    producer.mockImplementationOnce(() => {
      throw error;
    });
  }
  await import("./sqlite-readonly-location.worker.js");
  await vi.dynamicImportSettled();
  const prefix =
    (contention ? "Retryable SQLite inspection contention: " : "") +
    (allocationRefused ? "SQLite snapshot directory creation refused: " : "");
  const stdout = JSON.stringify({ ok: false, message: `${prefix}${message}` });
  expect(write).toHaveBeenCalledExactlyOnceWith(stdout);
  expect(process.exitCode).toBe(1);
  const { SqliteReadOnlyInspectionContentionError } =
    await import("./sqlite-readonly-worker-protocol.js");
  const received = await readFailure(stdout, mode);
  expect(received instanceof SqliteReadOnlyInspectionContentionError).toBe(contention);
  const { isPrivateDirectoryCreationRefused } = await import("./private-directory-creation.js");
  expect(isPrivateDirectoryCreationRefused(received)).toBe(contention && allocationRefused);
}

const codedError = (message: string, fields: { code?: string; errcode?: number }) =>
  Object.assign(new Error(message), fields);

type FailureOptions = {
  mode?: Parameters<typeof expectWorkerFailure>[3];
  refused?: boolean;
  contention?: boolean;
  allocationRefused?: boolean;
};
const failureCase = (error: unknown, message: string, options: FailureOptions = {}) => ({
  error,
  message,
  ...options,
});

function cyclicFailure() {
  const error = Object.assign(new Error("disk I/O error"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 778,
    errstr: "hidden errstr",
    stack: "hidden stack",
    sql: "hidden SQL",
    data: { code: "HIDDEN_DATA" },
    errors: [{ code: "HIDDEN_AGGREGATE" }],
  });
  error.cause = Object.assign(new Error("hidden cause message", { cause: error }), {
    code: "ERR_SQLITE_ERROR",
    errcode: 778,
  });
  return error;
}

function deepFailure() {
  let cause: unknown = { code: "HIDDEN_NINTH", errcode: 999 };
  for (let index = 7; index >= 0; index -= 1) {
    cause = Object.assign(new Error("staging failure", { cause }), {
      code: `E${index}`,
      errcode: index,
    });
  }
  return cause;
}

it.each([
  failureCase(
    codedError("parent token admission failed", { errcode: 5 }),
    "parent token admission failed (errcode=5)",
    { mode: "sync", refused: true, contention: true },
  ),
  failureCase(
    codedError("parent token admission failed", { errcode: 6 }),
    "parent token admission failed (errcode=6)",
    { mode: "staging-create-legacy", refused: true, contention: true, allocationRefused: true },
  ),
  failureCase(
    codedError("parent admission refused", { code: "EACCES" }),
    "parent admission refused (code=EACCES)",
    { mode: "staging-create", refused: true, allocationRefused: true },
  ),
  failureCase(
    codedError("allocation failed", { code: "ENOENT" }),
    "allocation failed (code=ENOENT)",
    { mode: "staging-create" },
  ),
  failureCase(new SourceChangedError("source changed"), "source changed", {
    contention: true,
  }),
  failureCase(cyclicFailure(), "disk I/O error (code=ERR_SQLITE_ERROR, errcode=778)"),
  failureCase(
    deepFailure(),
    "staging failure (code=E0, errcode=0, code=E1, errcode=1, code=E2, errcode=2, code=E3, errcode=3, code=E4, errcode=4, code=E5, errcode=5, code=E6, errcode=6, code=E7, errcode=7)",
  ),
  failureCase(codedError("failure", { code: "EIO\n", errcode: 11 }), "failure (errcode=11)"),
  ...[-1, 1.5, 2 ** 31].map((errcode) =>
    failureCase(codedError("failure", { code: "EIO", errcode }), "failure (code=EIO)"),
  ),
])(
  "serializes $message through the worker boundary",
  async ({
    error,
    message,
    mode = "async",
    refused,
    contention = false,
    allocationRefused = false,
  }) => {
    if (refused) {
      const { markPrivateDirectoryCreationRefused } =
        await import("./private-directory-creation.js");
      markPrivateDirectoryCreationRefused(error);
    }
    await expectWorkerFailure(error, message, contention, mode, allocationRefused);
  },
);

it.each([
  { kind: "wrong-mode", contention: true },
  { kind: "transport-failure", contention: false },
  { kind: "empty-failure", contention: true },
  { kind: "malformed-result", contention: false },
] as const)(
  "does not accept an allocation refusal receipt with $kind (contention: $contention)",
  async ({ kind, contention }) => {
    const stdout = JSON.stringify({
      ok: false,
      message:
        (contention ? "Retryable SQLite inspection contention: " : "") +
        "SQLite snapshot directory creation refused: root unavailable",
      ...(kind === "malformed-result" ? { unexpected: true } : {}),
    });
    const received = await readFailure(
      stdout,
      kind === "wrong-mode" ? "async" : "staging-create",
      kind === "transport-failure"
        ? "native transport failed"
        : kind === "empty-failure"
          ? ""
          : undefined,
    );
    const { isPrivateDirectoryCreationRefused } = await import("./private-directory-creation.js");
    expect(isPrivateDirectoryCreationRefused(received)).toBe(false);
  },
);
