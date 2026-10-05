import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { UPDATE_RECIPE_RESUME_CAPABILITY } from "./recipe-resume-contract.js";
import { continueInAuthenticatedTarget } from "./recipe-target-continuation.js";
import { UpdateCommandRecipeReconciliationPendingError } from "./update-command-recovery-error.js";
import { approvedContext } from "./update-recipe-context.test-support.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  verify: vi.fn(),
  bind: vi.fn(),
  catalog: vi.fn(),
  custody: vi.fn(),
  currentCatalog: vi.fn(),
  authority: vi.fn(),
  child: vi.fn(),
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runUtf8CommandWithTimeout: mocks.command,
}));
vi.mock("./update-recipe-context.js", async (original) => ({
  ...(await original<typeof import("./update-recipe-context.js")>()),
  verifyRecipeUpdateInstallation: mocks.verify,
  resolveAuthenticatedRecipeUpdateCatalog: mocks.catalog,
}));
vi.mock("./update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-executor.js")>()),
  captureUpdateCommandExecutorAuthority: mocks.authority,
  withUpdateCommandExecutorChild: async (
    _fence: unknown,
    _root: string,
    run: (grant: object, bind: typeof mocks.bind) => Promise<unknown>,
  ) => {
    mocks.child();
    return run({ runId }, mocks.bind);
  },
}));
vi.mock("./recipe-first-qualification.js", async (original) => ({
  ...(await original<typeof import("./recipe-first-qualification.js")>()),
  assertReleaseQualificationCustody: mocks.custody,
}));
vi.mock("../../infra/upgrade-recipes/catalog.js", async (original) => ({
  ...(await original<typeof import("../../infra/upgrade-recipes/catalog.js")>()),
  assertUpgradeRecipeCatalogCurrent: mocks.currentCatalog,
}));
function commandCall(index: number) {
  const call = mocks.command.mock.calls[index];
  if (!call) {
    throw new Error(`Expected command call ${index} was not observed`);
  }
  return call;
}
const originalExecArgv = process.execArgv;
afterEach(() => {
  process.execArgv = originalExecArgv;
  vi.restoreAllMocks();
});
const recipe = approvedContext();
recipe.maintenance.binding.runId = "00000000-0000-4000-8000-000000000001";
const runId = recipe.maintenance.binding.runId;
const response = () => ({
  capability: UPDATE_RECIPE_RESUME_CAPABILITY,
  runId,
  terminalRunId: runId,
  outcome: "completed",
  managedServiceVerified: true,
  result: {
    runId,
    status: "ok",
    mode: "npm",
    root: recipe.maintenance.binding.installationKey,
    after: {
      version: recipe.maintenance.expected.version,
      buildId: recipe.maintenance.expected.buildId,
    },
    steps: [],
    durationMs: 0,
    verification: {
      serviceRunning: true,
      versionMatch: true,
      readyz: true,
      settled: true,
      runningVersion: recipe.maintenance.expected.version,
      runningBuildId: recipe.maintenance.expected.buildId,
      port: recipe.maintenance.port,
      pid: 42,
    },
  },
});
const input = {
  recipe,
  ledgerPath: "/selected-state/state.sqlite",
  env: {},
  fence: { assertCurrent: vi.fn() },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog.mockImplementation(async () => {
    await mocks.custody();
    return {};
  });
  mocks.custody.mockResolvedValue(undefined);
  mocks.currentCatalog.mockImplementation(() => {});
  mocks.authority.mockReturnValue({ installKey: recipe.maintenance.binding.installationKey });
  mocks.command.mockImplementation(
    async (
      _args: string[],
      opts: { input?: string; beforeInput?: (pid: number, argv: readonly string[]) => void },
    ) => {
      if (!opts.input) {
        return {
          code: 0,
          termination: "exit",
          cleanup: "normal",
          stdout: JSON.stringify({
            executorDelegation: "pid-start-v1",
            recipeResume: UPDATE_RECIPE_RESUME_CAPABILITY,
          }),
        };
      }
      opts.beforeInput?.(42, _args);
      const payload = JSON.parse(opts.input);
      await fs.writeFile(payload.resultPath, JSON.stringify(response()), {
        mode: 0o600,
        flag: "wx",
      });
      return { code: 0, termination: "exit", cleanup: "normal", stderr: "" };
    },
  );
});
it("rehashes the installed target and binds the child before accepting exact readiness", async () => {
  await expect(continueInAuthenticatedTarget(input)).resolves.toMatchObject({
    terminalRunId: runId,
  });
  expect(mocks.verify).toHaveBeenCalledTimes(2);
  expect(mocks.bind).toHaveBeenCalledWith(42, commandCall(1)[0]);
  const args = mocks.command.mock.calls[1]?.[0];
  expect(args).toEqual([
    recipe.maintenance.expected.runtimeExecutable,
    expect.stringContaining("dist/"),
    "--recipe-resume",
  ]);
});
it("keeps semantic pending custody after a joined child loses its terminal response", async () => {
  mocks.command.mockImplementation(async (_args: string[], opts: { input?: string }) =>
    opts.input
      ? { code: 0, termination: "exit", cleanup: "normal", stderr: "" }
      : {
          code: 0,
          termination: "exit",
          cleanup: "normal",
          stdout: JSON.stringify({
            executorDelegation: "pid-start-v1",
            recipeResume: UPDATE_RECIPE_RESUME_CAPABILITY,
          }),
        },
  );
  await expect(continueInAuthenticatedTarget(input)).rejects.toBeInstanceOf(
    UpdateCommandRecipeReconciliationPendingError,
  );
});
it("refuses malformed target result objects even after successful process exit", async () => {
  mocks.command.mockImplementation(async (_args: string[], opts: { input?: string }) => {
    if (!opts.input) {
      return {
        code: 0,
        termination: "exit",
        cleanup: "normal",
        stdout: JSON.stringify({
          executorDelegation: "pid-start-v1",
          recipeResume: UPDATE_RECIPE_RESUME_CAPABILITY,
        }),
      };
    }
    await fs.writeFile(
      JSON.parse(opts.input).resultPath,
      JSON.stringify({ ...response(), result: null }),
      { mode: 0o600 },
    );
    return { code: 0, termination: "exit", cleanup: "normal", stderr: "" };
  });
  await expect(continueInAuthenticatedTarget(input)).rejects.toBeInstanceOf(
    UpdateCommandRecipeReconciliationPendingError,
  );
});
it("preserves genuine process cleanup uncertainty, rather than reporting semantic success", async () => {
  mocks.command.mockResolvedValue({
    code: 0,
    termination: "exit",
    cleanup: "uncertain",
    stdout: "",
  });
  await expect(continueInAuthenticatedTarget(input)).rejects.toBeInstanceOf(
    CommandProcessCleanupError,
  );
});

const inspectorFlag = "--inspect-brk=127.0.0.1:0";
function qualificationInput() {
  const qualified = structuredClone(recipe);
  qualified.releaseQualification = {
    purpose: "release-qualification",
    mountNamespace: "mnt:[123]",
    pidNamespace: "pid:[123]",
    recipe: qualified.route.recipe,
    machineId: "0".repeat(32),
    bootId: "00000000-0000-4000-8000-000000000002",
  };
  return { ...input, recipe: qualified };
}
it("refuses a production inspector observation before delegated target spawn", async () => {
  process.execArgv = [inspectorFlag];
  await expect(continueInAuthenticatedTarget(input)).rejects.toBeInstanceOf(
    UpdateCommandRecipeReconciliationPendingError,
  );
  expect(mocks.child).not.toHaveBeenCalled();
  expect(commandCall(0)[0]).not.toContain(inspectorFlag);
});
it("leaves qualification without the fixed inspector observation uninstrumented", async () => {
  process.execArgv = [];
  await continueInAuthenticatedTarget(qualificationInput());
  expect(commandCall(1)[0]).not.toContain(inspectorFlag);
  expect(mocks.custody).not.toHaveBeenCalled();
});
it("admits exactly one fixed pause only on the actual resume with unchanged child binding", async () => {
  process.execArgv = [inspectorFlag];
  await continueInAuthenticatedTarget(qualificationInput());
  expect(commandCall(0)[0]).not.toContain(inspectorFlag);
  expect(commandCall(1)[0]).toEqual([
    recipe.maintenance.expected.runtimeExecutable,
    inspectorFlag,
    expect.stringContaining("dist/"),
    "--recipe-resume",
  ]);
  expect(commandCall(0)[1].onOutputChunk).toBeUndefined();
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const observe = commandCall(1)[1].onOutputChunk;
    const announcement = Buffer.from("Debugger listening on ws://127.0.0.1:43123/fixture\n");
    observe(announcement, "stderr");
    observe(Buffer.from("result"), "stdout");
    expect(write).toHaveBeenCalledExactlyOnceWith(announcement);
  } finally {
    write.mockRestore();
  }
  expect(mocks.custody).toHaveBeenCalledOnce();
  expect(mocks.authority).toHaveBeenCalledWith(input.fence, runId);
  expect(mocks.bind).toHaveBeenCalledWith(42, commandCall(1)[0]);
});
it.each(["custody", "catalog", "executor"])(
  "refuses changed %s before inspector target spawn",
  async (failure) => {
    process.execArgv = [inspectorFlag];
    if (failure === "custody") {
      mocks.custody.mockRejectedValueOnce(new Error("custody lost"));
    }
    if (failure === "catalog") {
      mocks.currentCatalog.mockImplementationOnce(() => {
        throw new Error("catalog lost");
      });
    }
    if (failure === "executor") {
      mocks.authority.mockImplementationOnce(() => {
        throw new Error("executor lost");
      });
    }
    await expect(continueInAuthenticatedTarget(qualificationInput())).rejects.toBeInstanceOf(
      UpdateCommandRecipeReconciliationPendingError,
    );
    expect(mocks.child).not.toHaveBeenCalled();
  },
);
it("does not forward additional runtime flags even in qualification", async () => {
  process.execArgv = [inspectorFlag, "--expose-gc"];
  await expect(continueInAuthenticatedTarget(qualificationInput())).rejects.toBeInstanceOf(
    UpdateCommandRecipeReconciliationPendingError,
  );
  expect(mocks.child).not.toHaveBeenCalled();
});

it("refuses another original installation before inspector target spawn", async () => {
  process.execArgv = [inspectorFlag];
  mocks.authority.mockReturnValueOnce({ installKey: "/another-installation" });
  await expect(continueInAuthenticatedTarget(qualificationInput())).rejects.toBeInstanceOf(
    UpdateCommandRecipeReconciliationPendingError,
  );
  expect(mocks.child).not.toHaveBeenCalled();
});
it("reobserves the exact runtime flag after awaited custody admission", async () => {
  process.execArgv = [inspectorFlag];
  mocks.custody.mockImplementationOnce(async () => {
    process.execArgv = [];
  });
  await expect(continueInAuthenticatedTarget(qualificationInput())).rejects.toBeInstanceOf(
    UpdateCommandRecipeReconciliationPendingError,
  );
  expect(mocks.child).not.toHaveBeenCalled();
});
