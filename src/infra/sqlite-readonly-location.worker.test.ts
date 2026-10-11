import { afterEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";

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

async function expectWorkerFailure(
  error: unknown,
  message: string,
  contention = false,
  options?: {
    mode: "sync" | "async" | "staging-create" | "staging-create-legacy";
    allocationRefused: boolean;
  },
): Promise<void> {
  const mode = options?.mode ?? "async";
  process.argv = [
    process.execPath,
    "sqlite-readonly-location.worker.ts",
    "--openclaw-sqlite-readonly-child",
    mode,
    "/synthetic/database.sqlite",
  ];
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  if (mode === "staging-create" || mode === "staging-create-legacy") {
    createToken.mockImplementationOnce(() => {
      throw error;
    });
  } else if (mode === "sync") {
    prepareCopy.mockImplementationOnce(() => {
      throw error;
    });
  } else {
    prepare.mockRejectedValueOnce(error);
  }
  await import("./sqlite-readonly-location.worker.js");
  await vi.dynamicImportSettled();
  const prefix =
    (contention ? "Retryable SQLite inspection contention: " : "") +
    (options?.allocationRefused ? "SQLite snapshot directory creation refused: " : "");
  const stdout = JSON.stringify({
    ok: false,
    message: `${prefix}${message}`,
  });
  expect(write).toHaveBeenCalledExactlyOnceWith(stdout);
  expect(process.exitCode).toBe(1);
  const {
    readSqliteReadOnlyWorkerValue,
    SqliteReadOnlyInspectionContentionError,
    SqliteSnapshotAllocationRefusedError,
  } = await import("./sqlite-readonly-worker-protocol.js");
  let received: unknown;
  try {
    readSqliteReadOnlyWorkerValue({ kind: "launched", stdout, stderr: "", status: 0 }, mode);
  } catch (cause) {
    received = cause;
  }
  expect(received).toBeInstanceOf(Error);
  expect(received instanceof SqliteReadOnlyInspectionContentionError).toBe(contention);
  const { isPrivateDirectoryCreationRefused } = await import("./private-directory-creation.js");
  const allocationRefused =
    received instanceof SqliteSnapshotAllocationRefusedError ||
    isPrivateDirectoryCreationRefused(received);
  expect(allocationRefused).toBe(options?.allocationRefused === true);
}

it.each<{
  name: string;
  error: () => unknown;
  message: string;
  mode?: "sync" | "async" | "staging-create" | "staging-create-legacy";
  refused?: boolean;
  contention?: boolean;
  allocationRefused?: boolean;
}>([
  ...(
    [
      { mode: "sync", errcode: 5 },
      { mode: "staging-create-legacy", errcode: 6 },
    ] as const
  ).map(({ mode, errcode }) => ({
    name: `${mode} pre-creation contention`,
    mode,
    refused: true,
    contention: true,
    allocationRefused: mode === "staging-create-legacy",
    error: () => Object.assign(new Error("parent token admission failed"), { errcode }),
    message: `parent token admission failed (errcode=${errcode})`,
  })),
  {
    name: "pre-creation permission refusal",
    mode: "staging-create",
    refused: true,
    allocationRefused: true,
    error: () => Object.assign(new Error("parent admission refused"), { code: "EACCES" }),
    message: "parent admission refused (code=EACCES)",
  },
  {
    name: "ordinary allocation failure",
    mode: "staging-create",
    error: () => Object.assign(new Error("allocation failed"), { code: "ENOENT" }),
    message: "allocation failed (code=ENOENT)",
  },
  {
    name: "source contention",
    error: () => new SourceChangedError("source changed"),
    message: "source changed",
    contention: true,
  },
  {
    name: "cyclic causes without private details",
    error: () => {
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
    },
    message: "disk I/O error (code=ERR_SQLITE_ERROR, errcode=778)",
  },
  {
    name: "bounded cause traversal",
    error: () => {
      let cause: unknown = { code: "HIDDEN_NINTH", errcode: 999 };
      for (let index = 7; index >= 0; index -= 1) {
        cause = Object.assign(new Error("staging failure", { cause }), {
          code: `E${index}`,
          errcode: index,
        });
      }
      return cause;
    },
    message:
      "staging failure (code=E0, errcode=0, code=E1, errcode=1, code=E2, errcode=2, code=E3, errcode=3, code=E4, errcode=4, code=E5, errcode=5, code=E6, errcode=6, code=E7, errcode=7)",
  },
  {
    name: "unsafe code token",
    error: () => Object.assign(new Error("failure"), { code: "EIO\n", errcode: 11 }),
    message: "failure (errcode=11)",
  },
  ...[-1, 1.5, 2 ** 31].map((errcode) => ({
    name: `out-of-contract errcode ${errcode}`,
    error: () => Object.assign(new Error("failure"), { code: "EIO", errcode }),
    message: "failure (code=EIO)",
  })),
])(
  "serializes $name through the worker boundary",
  async ({
    error,
    message,
    mode = "async",
    refused,
    contention = false,
    allocationRefused = false,
  }) => {
    const failure = error();
    if (refused) {
      const { markPrivateDirectoryCreationRefused } =
        await import("./private-directory-creation.js");
      markPrivateDirectoryCreationRefused(failure);
    }
    await expectWorkerFailure(failure, message, contention, { mode, allocationRefused });
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
    const { readSqliteReadOnlyWorkerValue, SqliteSnapshotAllocationRefusedError } =
      await import("./sqlite-readonly-worker-protocol.js");
    const stdout = JSON.stringify({
      ok: false,
      message:
        (contention ? "Retryable SQLite inspection contention: " : "") +
        "SQLite snapshot directory creation refused: root unavailable",
      ...(kind === "malformed-result" ? { unexpected: true } : {}),
    });
    let received: unknown;
    try {
      readSqliteReadOnlyWorkerValue(
        {
          kind: "launched",
          stdout,
          stderr: "",
          status: 0,
          ...(kind === "transport-failure" ? { failure: "native transport failed" } : {}),
          ...(kind === "empty-failure" ? { failure: "" } : {}),
        },
        kind === "wrong-mode" ? "async" : "staging-create",
      );
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(Error);
    expect(received).not.toBeInstanceOf(SqliteSnapshotAllocationRefusedError);
    const { isPrivateDirectoryCreationRefused } = await import("./private-directory-creation.js");
    expect(isPrivateDirectoryCreationRefused(received)).toBe(false);
  },
);
