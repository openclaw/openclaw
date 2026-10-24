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
  const { readSqliteReadOnlyWorkerValue, SqliteReadOnlyInspectionContentionError } =
    await import("./sqlite-readonly-worker-protocol.js");
  const { isPrivateDirectoryCreationRefused } = await import("./private-directory-creation.js");
  let received: unknown;
  try {
    readSqliteReadOnlyWorkerValue(
      { kind: "launched", stdout, stderr: "", status: 0, failure },
      mode,
    );
  } catch (error) {
    received = error;
  }
  expect(received).toBeInstanceOf(Error);
  return {
    contention: received instanceof SqliteReadOnlyInspectionContentionError,
    refused: isPrivateDirectoryCreationRefused(received),
  };
}

type FailureOptions = {
  mode?: "sync" | "async" | "staging-create" | "staging-create-legacy";
  refused?: boolean;
  contention?: boolean;
  allocationRefused?: boolean;
};
async function expectWorkerFailure({
  error,
  message,
  contention = false,
  mode = "async",
  allocationRefused = false,
  refused,
}: ReturnType<typeof failureCase>): Promise<void> {
  if (refused) {
    const { markPrivateDirectoryCreationRefused } = await import("./private-directory-creation.js");
    markPrivateDirectoryCreationRefused(error);
  }
  process.argv = [process.execPath, "worker", "--openclaw-sqlite-readonly-child", mode, "/db"];
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
  expect(await readFailure(stdout, mode)).toEqual({
    contention,
    refused: contention && allocationRefused,
  });
}

const codedError = (fields: { code?: string; errcode?: number }) =>
  Object.assign(new Error("failure"), fields);

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
  failureCase(codedError({ errcode: 5 }), "failure (errcode=5)", {
    mode: "sync",
    refused: true,
    contention: true,
  }),
  failureCase(codedError({ errcode: 6 }), "failure (errcode=6)", {
    mode: "staging-create-legacy",
    refused: true,
    contention: true,
    allocationRefused: true,
  }),
  failureCase(codedError({ code: "EACCES" }), "failure (code=EACCES)", {
    mode: "staging-create",
    refused: true,
    allocationRefused: true,
  }),
  failureCase(codedError({ code: "ENOENT" }), "failure (code=ENOENT)", { mode: "staging-create" }),
  failureCase(new SourceChangedError("source changed"), "source changed", {
    contention: true,
  }),
  failureCase(cyclicFailure(), "disk I/O error (code=ERR_SQLITE_ERROR, errcode=778)"),
  failureCase(
    deepFailure(),
    "staging failure (code=E0, errcode=0, code=E1, errcode=1, code=E2, errcode=2, code=E3, errcode=3, code=E4, errcode=4, code=E5, errcode=5, code=E6, errcode=6, code=E7, errcode=7)",
  ),
  failureCase(codedError({ code: "EIO\n", errcode: 11 }), "failure (errcode=11)"),
  ...[-1, 1.5, 2 ** 31].map((errcode) =>
    failureCase(codedError({ code: "EIO", errcode }), "failure (code=EIO)"),
  ),
])("serializes $message through the worker boundary", expectWorkerFailure);

it.each([
  ["wrong-mode", true, "async", undefined],
  ["transport-failure", false, "staging-create", "native transport failed"],
  ["empty-failure", true, "staging-create", ""],
  ["malformed-result", false, "staging-create", undefined],
] as const)(
  "does not accept an allocation refusal receipt with %s (contention: %s)",
  async (kind, contention, mode, failure) => {
    const stdout = JSON.stringify({
      ok: false,
      message:
        (contention ? "Retryable SQLite inspection contention: " : "") +
        "SQLite snapshot directory creation refused: root unavailable",
      ...(kind === "malformed-result" ? { unexpected: true } : {}),
    });
    const received = await readFailure(stdout, mode, failure);
    expect(received.refused).toBe(false);
  },
);
