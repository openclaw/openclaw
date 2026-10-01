import { afterEach, describe, expect, it, vi } from "vitest";

const { prepare, prepareSync, createToken, SourceChangedError } = vi.hoisted(() => ({
  prepare: vi.fn(),
  prepareSync: vi.fn(),
  createToken: vi.fn(),
  SourceChangedError: class extends Error {},
}));
vi.mock("./sqlite-readonly-location.js", () => ({
  prepareSqliteReadOnlyLocationInProcess: prepare,
  prepareSqliteReadOnlyLocationSyncInProcess: prepareSync,
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
  prepareSync.mockReset();
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
    prepareSync.mockImplementationOnce(() => {
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
    readSqliteReadOnlyWorkerValue({ stdout, stderr: "" }, mode);
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

describe("SQLite read-only worker diagnostics", () => {
  it.each(["ERR_SQLITE_ERROR", 5])(
    "preserves token contention error code %s through the actual decoder",
    async (code) => {
      const { readSqliteReadOnlyWorkerValue, SqliteReadOnlyInspectionContentionError } =
        await import("./sqlite-readonly-worker-protocol.js");
      const stdout = JSON.stringify({
        ok: false,
        message: "Retryable SQLite inspection contention: token parent locked",
        code,
      });
      let received: unknown;
      try {
        readSqliteReadOnlyWorkerValue({ stdout, stderr: "" }, "token-reclaim");
      } catch (error) {
        received = error;
      }
      expect(received).toBeInstanceOf(SqliteReadOnlyInspectionContentionError);
      expect(received).toMatchObject({ code });
    },
  );

  it.each([
    { errcode: 5, contention: true },
    { errcode: 6, contention: true },
    { errcode: 261, contention: true },
    { errcode: 11, contention: false },
  ])(
    "preserves token SQLite result code $errcode for native classification",
    async ({ errcode, contention }) => {
      const { readSqliteReadOnlyWorkerValue, SqliteReadOnlyInspectionContentionError } =
        await import("./sqlite-readonly-worker-protocol.js");
      const { isSqliteLockError } = await import("./sqlite-error-diagnostics.js");
      const code = "ERR_SQLITE_ERROR";
      const stdout = JSON.stringify({
        ok: false,
        message:
          (contention ? "Retryable SQLite inspection contention: " : "") + "token admission failed",
        code,
        errcode,
      });
      let received: unknown;
      try {
        readSqliteReadOnlyWorkerValue({ stdout, stderr: "" }, "token-reclaim");
      } catch (error) {
        received = error;
      }
      expect(received).toBeInstanceOf(Error);
      expect(received instanceof SqliteReadOnlyInspectionContentionError).toBe(contention);
      expect(received).toMatchObject({ code, errcode });
      expect(isSqliteLockError(received)).toBe(contention);
    },
  );

  it.each([-1, 1.5, 2 ** 31, "5"])(
    "rejects invalid token SQLite result metadata: %s",
    async (errcode) => {
      const { readSqliteReadOnlyWorkerValue, SqliteReadOnlyInspectionContentionError } =
        await import("./sqlite-readonly-worker-protocol.js");
      const { isSqliteLockError } = await import("./sqlite-error-diagnostics.js");
      const stdout = JSON.stringify({
        ok: false,
        message: "Retryable SQLite inspection contention: token admission failed",
        code: "ERR_SQLITE_ERROR",
        errcode,
      });
      let received: unknown;
      try {
        readSqliteReadOnlyWorkerValue({ stdout, stderr: "" }, "token-reclaim");
      } catch (error) {
        received = error;
      }
      expect(received).toBeInstanceOf(Error);
      expect(received).toMatchObject({
        message: expect.stringContaining("returned an invalid result"),
      });
      expect(received).not.toBeInstanceOf(SqliteReadOnlyInspectionContentionError);
      expect(isSqliteLockError(received)).toBe(false);
    },
  );

  it.each([
    { mode: "sync", errcode: 5 },
    { mode: "staging-create-legacy", errcode: 6 },
  ] as const)(
    "preserves pre-creation contention $errcode in $mode replies",
    async ({ mode, errcode }) => {
      const { markPrivateDirectoryCreationRefused } =
        await import("./private-directory-creation.js");
      const cause = Object.assign(new Error("parent token admission failed"), { errcode });
      await expectWorkerFailure(
        markPrivateDirectoryCreationRefused(cause),
        `parent token admission failed (errcode=${errcode})`,
        true,
        { mode, allocationRefused: mode === "staging-create-legacy" },
      );
    },
  );

  it.each(["staging-create"] as const)(
    "keeps the released failure shape while carrying a pre-creation refusal for %s",
    async (mode) => {
      const { markPrivateDirectoryCreationRefused } =
        await import("./private-directory-creation.js");
      const cause = Object.assign(new Error("parent admission refused"), { code: "EACCES" });
      await expectWorkerFailure(
        markPrivateDirectoryCreationRefused(cause),
        "parent admission refused (code=EACCES)",
        false,
        { mode, allocationRefused: true },
      );
    },
  );

  it("does not label an ordinary allocation failure as never created", async () => {
    await expectWorkerFailure(
      Object.assign(new Error("allocation failed"), { code: "ENOENT" }),
      "allocation failed (code=ENOENT)",
      false,
      { mode: "staging-create", allocationRefused: false },
    );
  });

  it.each([
    { kind: "wrong-mode", contention: true },
    { kind: "transport-failure", contention: false },
    { kind: "empty-failure", contention: true },
    { kind: "malformed-result", contention: false },
    { kind: "token-code", contention: false },
    { kind: "token-code", contention: true },
    { kind: "token-code-transport", contention: false },
    { kind: "token-code-transport", contention: true },
    { kind: "token-errcode", contention: false },
    { kind: "token-errcode", contention: true },
    { kind: "token-errcode-transport", contention: false },
    { kind: "token-errcode-transport", contention: true },
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
        ...(kind === "token-code" || kind === "token-code-transport"
          ? { code: "ERR_SQLITE_ERROR" }
          : {}),
        ...(kind === "token-errcode" || kind === "token-errcode-transport" ? { errcode: 5 } : {}),
      });
      let received: unknown;
      try {
        readSqliteReadOnlyWorkerValue(
          {
            stdout,
            stderr: "",
            ...(kind === "transport-failure" ||
            kind === "token-code-transport" ||
            kind === "token-errcode-transport"
              ? { failure: "native transport failed" }
              : {}),
            ...(kind === "empty-failure" ? { failure: "" } : {}),
          },
          kind === "wrong-mode" ? "async" : "staging-create",
        );
      } catch (error) {
        received = error;
      }
      expect(received).toBeInstanceOf(Error);
      expect(received).not.toBeInstanceOf(SqliteSnapshotAllocationRefusedError);
      if (kind === "token-code-transport" || kind === "token-errcode-transport") {
        expect(received).toMatchObject({
          message: expect.stringContaining("native transport failed"),
        });
      }
      const { isPrivateDirectoryCreationRefused } = await import("./private-directory-creation.js");
      expect(isPrivateDirectoryCreationRefused(received)).toBe(false);
    },
  );

  it("retains source contention as a typed parent error", async () => {
    await expectWorkerFailure(new SourceChangedError("source changed"), "source changed", true);
  });

  it("deduplicates cyclic cause codes without exposing other error details", async () => {
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
    await expectWorkerFailure(error, "disk I/O error (code=ERR_SQLITE_ERROR, errcode=778)");
  });

  it("bounds cause traversal while retaining codes from the last admitted node", async () => {
    let cause: unknown = { code: "HIDDEN_NINTH", errcode: 999 };
    for (let index = 7; index >= 0; index -= 1) {
      cause = Object.assign(new Error("staging failure", { cause }), {
        code: `E${index}`,
        errcode: index,
      });
    }
    await expectWorkerFailure(
      cause,
      "staging failure (code=E0, errcode=0, code=E1, errcode=1, code=E2, errcode=2, code=E3, errcode=3, code=E4, errcode=4, code=E5, errcode=5, code=E6, errcode=6, code=E7, errcode=7)",
    );
  });

  it.each(["EIO\n"])("omits unsafe code tokens: %j", async (code) => {
    await expectWorkerFailure(
      Object.assign(new Error("failure"), { code, errcode: 11 }),
      "failure (errcode=11)",
    );
  });

  it.each([-1, 1.5, 2 ** 31])(
    "omits errcode values outside Node's nonnegative signed integer contract: %s",
    async (errcode) => {
      await expectWorkerFailure(
        Object.assign(new Error("failure"), { code: "EIO", errcode }),
        "failure (code=EIO)",
      );
    },
  );
});
