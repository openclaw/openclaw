import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { execFileUtf8 } from "../../daemon/exec-file.js";
import { assertGatewayServiceUpdateCurrent } from "../../daemon/service-update-authority.js";
import { readGatewayServiceState } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as processRunner from "../../process/exec.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { withRetainedUpdateServiceAuthority } from "./update-command-retained-service.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let serviceRoot: string;
beforeEach(() => {
  root = fs.realpathSync(dirs.make("native-inspection-"));
  serviceRoot = path.join(root, "A");
  fs.mkdirSync(serviceRoot, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "control"), { mode: 0o700 });
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(path.join(root, "control"));
});
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32").each([true, false])(
  "joins native inspection children before parent-owned reads (command present: %s)",
  async (commandPresent) => {
    const runCommand = processRunner.runCommandWithTimeout;
    let bound!: () => void;
    const childBound = new Promise<void>((resolve) => {
      bound = resolve;
    });
    let nativeReads = 0;
    const runId = randomUUID();
    await withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root, { serviceRoot });
      vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        assert(typeof options !== "number");
        return runCommand(argv, {
          ...options,
          beforeInput(pid, spawnedArgv) {
            options.beforeInput?.(pid, spawnedArgv);
            expect(() => fence.assertCurrent()).toThrow("The update process is still running.");
            bound();
          },
        });
      });
      const nativeRead = async () => {
        const result = await execFileUtf8(
          process.execPath,
          ["-e", 'process.stdout.write("loaded");'],
          { timeout: 5000 },
        );
        expect(result).toMatchObject({ code: 0, stdout: "loaded" });
        nativeReads++;
        return true;
      };
      // Native subprocess custody and settlement are real. The platform adapter
      // models a direct peer read, which must still own the parent executor.
      const service = createMockGatewayService({
        readCommand: async () =>
          commandPresent ? { programArguments: ["node", "gateway"] } : null,
        hasInstalledDefinition: nativeRead,
        isLoaded: nativeRead,
        readRuntime: async () => {
          await childBound;
          assertGatewayServiceUpdateCurrent();
          return { status: "stopped", managerUid: 1001 };
        },
      });
      const state = await withRetainedUpdateServiceAuthority(
        {
          run: { runId, env: {}, executorFence: fence },
          root: serviceRoot,
          assertCurrent: () => {},
        },
        () =>
          readGatewayServiceState(service, { env: {}, requireEffective: true, timeoutMs: 5000 }),
      );
      expect(state.loadState).toEqual({ status: "loaded" });
      expect(state.runtime).toMatchObject({ status: "stopped", managerUid: 1001 });
      expect(state.installed).toBe(true);
      expect(nativeReads).toBe(commandPresent ? 1 : 2);
      fence.assertCurrent();
    });
  },
  15000,
);

it("keeps ordinary status reads concurrent without retained native custody", async () => {
  let runtimeStarted!: () => void;
  const runtimeReady = new Promise<void>((resolve) => {
    runtimeStarted = resolve;
  });
  const service = createMockGatewayService({
    readCommand: async () => ({ programArguments: ["node", "gateway"] }),
    isLoaded: async () => {
      await runtimeReady;
      return true;
    },
    readRuntime: async () => {
      runtimeStarted();
      return { status: "running" };
    },
  });
  const state = await readGatewayServiceState(service);
  expect(state.loadState).toEqual({ status: "loaded" });
  expect(state.running).toBe(true);
});

it
  .skipIf(process.platform === "win32")
  .each([
    "requester-revoked",
    "fence-reassigned",
    "A-revoked",
    "B-revoked",
    "cleanup-uncertain",
  ] as const)(
  "does not certify an inspection after %s",
  async (change) => {
    const runCommand = processRunner.runCommandWithTimeout;
    const runId = randomUUID();
    let parentReads = 0;
    let actualCommands = 0;
    let current = true;
    const work = withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root, { serviceRoot });
      const run: NonNullable<UpdateCommandOptions["run"]> = {
        runId,
        env: {},
        executorFence: fence,
      };
      vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        const result = await runCommand(argv, options);
        expect(result).toMatchObject({ code: 0, termination: "exit" });
        actualCommands++;
        if (change === "requester-revoked") {
          current = false;
        }
        if (change === "fence-reassigned") {
          run.executorFence = { assertCurrent() {} };
        }
        if (change === "A-revoked" || change === "B-revoked") {
          const db = new DatabaseSync(path.join(root, "control", "managed-update-handoffs.sqlite"));
          try {
            const changed = db
              .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
              .run("replacement", change === "A-revoked" ? serviceRoot : root);
            expect(changed.changes).toBe(1);
          } finally {
            db.close();
          }
        }
        // The process really settled. Only this negative cleanup classification is injected.
        return change === "cleanup-uncertain" ? { ...result, cleanup: "uncertain" } : result;
      });
      const service = createMockGatewayService({
        readCommand: async () => ({ programArguments: ["node", "gateway"] }),
        isLoaded: async () => {
          const result = await execFileUtf8(
            process.execPath,
            ["-e", 'process.stdout.write("loaded");'],
            { timeout: 5000 },
          );
          if (result.code !== 0) {
            throw new Error(result.stderr);
          }
          return true;
        },
        readRuntime: async () => {
          assertGatewayServiceUpdateCurrent();
          parentReads++;
          return { status: "stopped", managerUid: 1001 };
        },
      });
      return withRetainedUpdateServiceAuthority(
        {
          run,
          root: serviceRoot,
          assertCurrent: () => {
            if (!current) {
              throw new Error("requester revoked");
            }
          },
        },
        () =>
          readGatewayServiceState(service, { env: {}, requireEffective: true, timeoutMs: 5000 }),
      );
    });
    if (change === "cleanup-uncertain") {
      await expect(work).rejects.toThrow(
        "Command cleanup could not confirm that owned work stopped",
      );
    } else {
      const reason =
        change === "requester-revoked"
          ? "requester revoked"
          : change === "fence-reassigned"
            ? "Retained service lost its original executor."
            : "Update failed and executor release remains pending";
      await expect(work).rejects.toThrow(reason);
    }
    expect(actualCommands).toBe(1);
    expect(parentReads).toBe(0);
  },
  15000,
);
