import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getGatewayServiceUpdateNativeCommand } from "../../daemon/service-update-authority.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import * as processExec from "../../process/exec.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { createPackageRuntimeRecovery } from "./update-command-node-runtime.js";
import { withRetainedUpdateServiceAuthority } from "./update-command-retained-service.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32").each(
  [
    { code: 0, cleanup: "forced" as const },
    { code: 7, cleanup: "forced" as const },
    { code: 7, cleanup: "uncertain" as const },
  ].flatMap((outcome) =>
    ["native", "installer", "receiver"].map((kind) => ({
      code: outcome.code,
      cleanup: outcome.cleanup,
      kind,
    })),
  ),
)(
  "retains A and B custody for $kind code=$code cleanup=$cleanup",
  async ({ code, cleanup, kind }) => {
    const home = fs.realpathSync(dirs.make("retained-cleanup-"));
    const a = path.join(home, "A");
    const b = path.join(home, "B");
    const control = path.join(home, "control");
    for (const dir of [a, b, control]) {
      fs.mkdirSync(dir);
    }
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    // A real bound child establishes persistent custody. The result injection
    // exercises cleanup classifications without leaving any live test process.
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (_argv, options) => {
      const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      const closed = once(child, "close");
      try {
        if (!child.pid || typeof options === "number") {
          throw new Error("missing child binding");
        }
        options.beforeInput?.(child.pid, child.spawnargs);
      } finally {
        child.stdin.end();
        await closed;
      }
      return {
        code,
        cleanup,
        termination: "exit",
        signal: null,
        killed: cleanup === "forced",
        stdout: "",
        stderr: "",
      };
    });
    const run: NonNullable<UpdateCommandOptions["run"]> = { runId: randomUUID(), env: {} };
    const operation = withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(b, { serviceRoot: a });
      if (kind === "receiver") {
        fs.mkdirSync(path.join(b, "dist"));
        fs.writeFileSync(path.join(b, "dist", "index.js"), "export {};\n");
        await runUpdatedInstallGatewayCommand(
          { result: { root: b }, opts: { run }, invocationEnv: {}, timeoutMs: 5000 },
          "restart",
        );
        return;
      }
      if (kind === "installer") {
        const recovery = createPackageRuntimeRecovery({ root: b, opts: { run }, timeoutMs: 5000 });
        if (!recovery.installCommand) {
          throw new Error("missing admitted runtime installer");
        }
        await recovery.installCommand(process.execPath, ["-e", ""], {});
        return;
      }
      await withRetainedUpdateServiceAuthority(
        { run, root: a, assertCurrent: () => {} },
        async () => {
          const command = getGatewayServiceUpdateNativeCommand();
          if (!command) {
            throw new Error("missing retained native command");
          }
          await command([process.execPath, "-e", ""], { timeoutMs: 5000 });
        },
      );
    });
    await expect(operation).rejects.toSatisfy(hasCommandProcessCleanupError);
    const store = createManagedHandoffLeaseStore();
    for (const root of [a, b]) {
      expect(store.read(root).kind).toBe("current");
      expect(store.acquire(root, randomUUID(), { kind: "update" }).kind).toBe("busy");
    }
  },
);
