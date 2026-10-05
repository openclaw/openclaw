import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/io.factory.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import * as childCommands from "../../process/exec.js";
import * as qualificationInspector from "./recipe-qualification.js";
import * as executorOwner from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import * as sourceRuntimeOwner from "./update-command-runtime.js";
import * as recipeContextOwner from "./update-recipe-context.js";
import { approvedContext } from "./update-recipe-context.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

// Transport-only regression: never start an inspected subprocess without its debugger.
// Actual receiver/native custody remains covered by the unmocked migrated sibling suite.
it.each([
  { kind: "qualified", flag: "--inspect-brk=127.0.0.1:0" },
  { kind: "recipe-normal", flag: undefined },
  { kind: "nonrecipe", flag: undefined },
  { kind: "legacy", flag: undefined },
  { kind: "admission-refused", flag: undefined },
  { kind: "release-refused", flag: undefined },
])(
  "selects migrated finalizer transport only after source settlement ($kind)",
  async ({ kind, flag }) => {
    const stateDir = dirs.make("migrated-inspector-transport-");
    const root = path.join(stateDir, "installation");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const fence = { assertCurrent: vi.fn() };
    const recipe = approvedContext();
    const recipeSelected = !["nonrecipe", "legacy"].includes(kind);
    const events: string[] = [];
    const bind = vi.fn();
    vi.spyOn(recipeContextOwner, "assertRecipeUpdateBinding").mockImplementation(() => {});
    vi.spyOn(recipeContextOwner, "verifyRecipeUpdateInstallation").mockResolvedValue({
      root,
      releaseId: recipe.targetReleaseId,
      buildId: "fixture-target",
      manifestArtifactId: "fixture-manifest",
      manifestDigest: "a".repeat(64),
      fileCount: 1,
    });
    vi.spyOn(executorOwner, "requiresRetainedUpdateCommandOwner").mockReturnValue(false);
    vi.spyOn(executorOwner, "withUpdateCommandExecutorChild").mockImplementation(
      async (_fence, selectedRoot, callback) => {
        events.push("delegated");
        return callback(
          {
            runId: "transport-run",
            root: selectedRoot,
            databasePath: "/fixture/lease.sqlite",
            childKey: "child",
            parent: {
              version: 1,
              key: "parent",
              owner: "fixture",
              payload: "fixture",
              updatedAt: 1,
              helper: { pid: 1, startIdentity: "fixture-helper" },
              executor: { pid: 2, startIdentity: "fixture-executor" },
              action: { kind: "update" },
            },
          },
          bind,
        );
      },
    );
    let releaseEntered!: () => void;
    let releaseSettled!: () => void;
    const entered = new Promise<void>((resolve) => {
      releaseEntered = resolve;
    });
    const settlement = new Promise<void>((resolve) => {
      releaseSettled = resolve;
    });
    const release = vi
      .spyOn(sourceRuntimeOwner, "releaseLegacySourceLock")
      .mockImplementation(async () => {
        events.push("release-entered");
        releaseEntered();
        await settlement;
        if (kind === "release-refused") {
          throw new Error("source settlement refused");
        }
        events.push("release-settled");
      });
    const admission = vi
      .spyOn(qualificationInspector, "admitReleaseQualificationChildInspector")
      .mockImplementation(async () => {
        events.push("admitted");
        if (kind === "admission-refused") {
          throw new Error("qualification custody refused");
        }
        return flag;
      });
    const command = vi
      .spyOn(childCommands, "runUtf8CommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        if (argv.at(-1) === "--check") {
          events.push("check");
          return {
            stdout: JSON.stringify({
              executorDelegation: "pid-start-v1",
              recipeUpdate: recipeContextOwner.UPDATE_RECIPE_UPDATE_CAPABILITY,
            }),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
            cleanup: "normal",
          };
        }
        events.push("finalizer");
        if (typeof options === "number") {
          throw new Error("Missing finalizer transport options");
        }
        expect(typeof options.onOutputChunk).toBe(kind === "qualified" ? "function" : "undefined");
        if (kind === "qualified") {
          const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
          try {
            const announcement = Buffer.from(
              "Debugger listening on ws://127.0.0.1:43123/fixture\n",
            );
            options.onOutputChunk?.(announcement, "stderr");
            options.onOutputChunk?.(Buffer.from("result"), "stdout");
            expect(write).toHaveBeenCalledExactlyOnceWith(announcement);
          } finally {
            write.mockRestore();
          }
        }
        options.beforeInput?.(4242, argv);
        // Stop at the mocked transport boundary; no subprocess, result fabrication or ledger mutation.
        throw new Error("transport observed");
      });
    const params: FinishUpdateParams = {
      mutationStarted: true,
      result: { status: "ok", mode: "npm", root, steps: [], durationMs: 0 },
      root,
      installKindChanged: false,
      configSnapshot: await createConfigIO({ env, observe: false }).readConfigFileSnapshot(),
      requestedChannel: null,
      storedChannel: "stable",
      channel: "stable",
      downgradeRisk: false,
      shouldRestart: false,
      opts: {
        json: true,
        run: {
          runId: "transport-run",
          env,
          ...(kind === "legacy" ? {} : { executorFence: fence }),
        },
        ...(recipeSelected ? { recipe } : {}),
      },
      controlPlaneUpdateSentinelMeta: null,
      preUpdatePluginInstallRecords: {},
      startedAt: Date.now(),
      packageUpdateNodeRunner: process.execPath,
      updateStepTimeoutMs: 30_000,
    };
    // Attach the rejection handler immediately while the source-lock promise is deliberately unsettled.
    const outcome = continueMigratedUpdateInFreshProcess(params, []).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    await entered;
    expect(admission).not.toHaveBeenCalled();
    expect(events).not.toContain("delegated");
    expect(events).not.toContain("finalizer");
    releaseSettled();
    const expectedError =
      kind === "release-refused"
        ? "source settlement refused"
        : kind === "admission-refused"
          ? "qualification custody refused"
          : "transport observed";
    expect((await outcome).error).toEqual(expect.objectContaining({ message: expectedError }));
    expect(release).toHaveBeenCalledWith(root, undefined);
    const worker = path.join(
      root,
      "dist",
      runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
    );
    const checkCalls = command.mock.calls.filter(([argv]) => argv.at(-1) === "--check");
    expect(checkCalls).toHaveLength(kind === "legacy" ? 0 : 1);
    for (const [argv] of checkCalls) {
      expect(argv).toEqual([process.execPath, worker, "--check"]);
    }
    const actualCalls = command.mock.calls.filter(([argv]) => argv.at(-1) !== "--check");
    if (kind === "release-refused" || kind === "admission-refused") {
      expect(actualCalls).toHaveLength(0);
      expect(bind).not.toHaveBeenCalled();
      expect(events).not.toContain("delegated");
      if (kind === "release-refused") {
        expect(admission).not.toHaveBeenCalled();
      }
      return;
    }
    const selectedArgv = flag ? [process.execPath, flag, worker] : [process.execPath, worker];
    expect(actualCalls).toHaveLength(1);
    expect(actualCalls[0]?.[0]).toEqual(selectedArgv);
    if (kind === "legacy") {
      expect(bind).not.toHaveBeenCalled();
    } else {
      expect(bind).toHaveBeenCalledExactlyOnceWith(4242, selectedArgv);
    }
    if (recipeSelected) {
      expect(admission).toHaveBeenCalledExactlyOnceWith(recipe, fence);
      expect(events.indexOf("release-settled")).toBeLessThan(events.indexOf("admitted"));
      expect(events.indexOf("admitted")).toBeLessThan(events.indexOf("delegated"));
    } else {
      expect(admission).not.toHaveBeenCalled();
    }
  },
);
