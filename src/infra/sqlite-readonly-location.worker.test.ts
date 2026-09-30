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
  it("keeps combined refusal compatible with the existing parent contention decoder", async () => {
    const { readSqliteReadOnlyWorkerValue, SqliteReadOnlyInspectionContentionError } =
      await import("./sqlite-readonly-worker-protocol.js");
    const stdout = JSON.stringify({
      ok: false,
      message:
        "Retryable SQLite inspection contention: SQLite snapshot directory creation refused: parent locked",
    });
    expect(() => readSqliteReadOnlyWorkerValue({ stdout, stderr: "" }, "staging-create")).toThrow(
      SqliteReadOnlyInspectionContentionError,
    );
  });

  it.each(
    (["sync", "async", "staging-create", "staging-create-legacy"] as const).flatMap((mode) =>
      [5, 6].map((errcode) => ({ mode, errcode })),
    ),
  )("preserves pre-creation contention $errcode in $mode replies", async ({ mode, errcode }) => {
    const { markPrivateDirectoryCreationRefused } = await import("./private-directory-creation.js");
    const cause = Object.assign(new Error("parent token admission failed"), { errcode });
    await expectWorkerFailure(
      markPrivateDirectoryCreationRefused(cause),
      `parent token admission failed (errcode=${errcode})`,
      true,
      { mode, allocationRefused: mode === "staging-create" || mode === "staging-create-legacy" },
    );
  });

  it.each(["staging-create", "staging-create-legacy"] as const)(
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

  it("does not publish a creation receipt from an unrelated operation", async () => {
    const { markPrivateDirectoryCreationRefused } = await import("./private-directory-creation.js");
    await expectWorkerFailure(
      markPrivateDirectoryCreationRefused(new Error("pre-creation refusal")),
      "pre-creation refusal",
    );
  });

  it.each(
    (
      [
        "wrong-mode",
        "retirement-mode",
        "transport-failure",
        "empty-failure",
        "malformed-result",
      ] as const
    ).flatMap((kind) => [false, true].map((contention) => ({ kind, contention }))),
  )(
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
            stdout,
            stderr: "",
            ...(kind === "transport-failure" ? { failure: "native transport failed" } : {}),
            ...(kind === "empty-failure" ? { failure: "" } : {}),
          },
          kind === "wrong-mode"
            ? "async"
            : kind === "retirement-mode"
              ? "staging-retire"
              : "staging-create",
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

  it("reads cause metadata once through the registered worker", async () => {
    let causeReads = 0;
    const failure = Object.defineProperty(new Error("open failure"), "cause", {
      get() {
        causeReads += 1;
        return undefined;
      },
    });
    await expectWorkerFailure(failure, "open failure");
    expect(causeReads).toBe(1);
  });

  it("retains source contention as a typed parent error", async () => {
    await expectWorkerFailure(new SourceChangedError("source changed"), "source changed", true);
  });

  it.each([
    { errcode: 5, contention: true },
    { errcode: 6, contention: true },
    { errcode: 11, contention: false },
    { errcode: 26, contention: false },
  ])(
    "classifies native inspection failure $errcode without parsing prose",
    async ({ errcode, contention }) => {
      await expectWorkerFailure(
        Object.assign(new Error("inspection failed"), { errcode }),
        `inspection failed (errcode=${errcode})`,
        contention,
      );
    },
  );

  it.each([
    { error: new Error(""), message: "" },
    { error: "plain failure", message: "plain failure" },
    { error: { message: "hidden structured message" }, message: "[object Object]" },
  ])("preserves the original top-level message: $message", async ({ error, message }) => {
    await expectWorkerFailure(error, message);
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

  it.each(["", "lowercase", "EIO\n", "E".repeat(65), { secret: "hidden" }])(
    "omits unsafe code tokens: %j",
    async (code) => {
      await expectWorkerFailure(
        Object.assign(new Error("failure"), { code, errcode: 11 }),
        "failure (errcode=11)",
      );
    },
  );

  it.each([-1, 1.5, 2 ** 31, "778"])(
    "omits errcode values outside Node's nonnegative signed integer contract: %s",
    async (errcode) => {
      await expectWorkerFailure(
        Object.assign(new Error("failure"), { code: "EIO", errcode }),
        "failure (code=EIO)",
      );
    },
  );

  it("retains the maximum allowed code token and SQLite integer", async () => {
    const code = "E".repeat(64);
    await expectWorkerFailure(
      Object.assign(new Error("failure"), { code, errcode: 2 ** 31 - 1 }),
      `failure (code=${code}, errcode=2147483647)`,
    );
  });
});
