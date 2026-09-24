import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { execFileUtf8 } from "../../daemon/exec-file.js";
import * as futureConfig from "../../daemon/future-config-guard.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import type { GatewayServiceControlArgs } from "../../daemon/service-types.js";
import { assertGatewayServiceUpdateCurrent } from "../../daemon/service-update-authority.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import * as systemdExec from "../../daemon/systemd-exec.js";
import * as systemdScope from "../../daemon/systemd-scope.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import type { UpdateCommandOptions } from "./shared.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import * as commands from "./update-command-service-command.js";

// Exercise the real guarded registry and systemd restart on every host. Only the
// manager transport/scope is synthetic; native commands run real disposable children.
vi.mock("../../daemon/launchd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd.js")>()),
  restartLaunchAgent: async (args: GatewayServiceControlArgs) =>
    (await import("../../daemon/systemd-lifecycle.js")).restartSystemdService(args),
}));
vi.mock("../../daemon/schtasks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/schtasks.js")>()),
  restartScheduledTask: async (args: GatewayServiceControlArgs) =>
    (await import("../../daemon/systemd-lifecycle.js")).restartSystemdService(args),
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
let a: string;
let b: string;
let c: string;
let control: string;
let env: NodeJS.ProcessEnv;
const success = { stdout: "", stderr: "", code: 0, termination: "exit" as const };

beforeEach(() => {
  const dir = fs.realpathSync(dirs.make("retained-native-r6-"));
  a = path.join(dir, "A");
  b = path.join(dir, "B");
  c = path.join(dir, "C");
  control = path.join(dir, "control");
  for (const root of [a, b, c, control]) {
    fs.mkdirSync(root);
  }
  env = { HOME: dir, OPENCLAW_STATE_DIR: path.join(dir, ".openclaw") };
  vi.stubEnv("HOME", dir);
  mockSystemAccountHome();
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_PROFILE",
    "OPENCLAW_SUPERVISOR_MODE",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR!);
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  vi.spyOn(systemdScope, "findInstalledSystemdGatewayScope").mockResolvedValue({
    scope: "user",
    unitName: "fixture-A.service",
    unitPath: path.join(a, "unit"),
  });
  vi.spyOn(systemdScope, "assertNoSystemGatewayOwnership").mockResolvedValue();
  vi.spyOn(systemdExec, "assertSystemdAvailable").mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function revoke(root: string) {
  const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
  try {
    expect(
      db
        .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
        .run("replacement", root).changes,
    ).toBe(1);
  } finally {
    db.close();
  }
}
function request(run: NonNullable<UpdateCommandOptions["run"]>, root = a) {
  return {
    run,
    root,
    env,
    stdout: new PassThrough(),
    assertCurrent: () => undefined,
    revalidate: async () => undefined,
  };
}
function owned(
  operation: (run: NonNullable<UpdateCommandOptions["run"]>) => Promise<void>,
  retained = true,
) {
  const run: NonNullable<UpdateCommandOptions["run"]> = { runId: randomUUID(), env };
  return withUpdateCommandExecutor(run.runId, async (executor) => {
    run.executorFence = await executor.enter(b, retained ? { serviceRoot: a } : undefined);
    await operation(run);
  });
}

describe.skipIf(process.platform === "win32")("retained POSIX native restart", () => {
  it("restarts retained A with a real child and keeps both owners until native drain", async () => {
    const effect = path.join(a, "effect");
    const proceed = path.join(a, "proceed");
    const started = createDeferred();
    const definition = path.join(a, "unit");
    fs.writeFileSync(definition, "original Node A and service definition");
    let pid = 0;
    const native = vi
      .spyOn(systemdExec, "execSystemctlUser")
      .mockImplementation(async (_env, args, _timeout, assertCurrent) => {
        assertCurrent?.();
        assertGatewayServiceUpdateCurrent();
        if (args[0] === "reset-failed") {
          return success;
        }
        expect(args).toEqual(["restart", "fixture-A.service"]);
        const running = execFileUtf8(process.execPath, [
          "-e",
          `
      const fs=require("node:fs");
      fs.writeFileSync(${JSON.stringify(effect + ".tmp")},String(process.pid));
      fs.renameSync(${JSON.stringify(effect + ".tmp")},${JSON.stringify(effect)});
      const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(proceed)})){clearInterval(timer);process.stdout.write("drained");}},10);
    `,
        ]);
        await vi.waitFor(() => expect(fs.existsSync(effect)).toBe(true));
        pid = Number(fs.readFileSync(effect, "utf8"));
        started.resolve();
        return await running;
      });
    let complete = false;
    const work = owned(async (run) => {
      await expect(commands.restartRetainedUpdateGatewayService(request(run))).resolves.toEqual({
        outcome: "completed",
      });
    }).then(() => {
      complete = true;
    });
    try {
      await Promise.race([started.promise, work]);
      expect(pid).toBeGreaterThan(0);
      expect(pid).not.toBe(process.pid);
      expect(complete).toBe(false);
      const store = createManagedHandoffLeaseStore();
      for (const root of [a, b]) {
        expect(store.acquire(root, randomUUID(), { kind: "update" }).kind).toBe("busy");
      }
      expect(store.read(c)).toEqual({ kind: "absent" });
      fs.writeFileSync(proceed, "");
      await work;
      expect(native.mock.calls.map((call) => call[1][0])).toEqual(["reset-failed", "restart"]);
      expect(fs.readFileSync(definition, "utf8")).toBe("original Node A and service definition");
      for (const root of [a, b]) {
        expect(store.read(root)).toEqual({ kind: "absent" });
      }
    } finally {
      fs.writeFileSync(proceed, "");
      await work.catch(() => undefined);
    }
  });

  it.each(["A", "B", "caller", "executor", "abort"] as const)(
    "refuses after the native lock/config await changes %s",
    async (fault) => {
      const native = vi.spyOn(systemdExec, "execSystemctlUser").mockResolvedValue(success);
      const controller = new AbortController();
      let callerCurrent = true;
      const work = owned(async (run) => {
        vi.spyOn(futureConfig, "assertFutureConfigActionAllowed").mockImplementation(async () => {
          await Promise.resolve();
          if (fault === "A" || fault === "B") {
            revoke(fault === "A" ? a : b);
          } else if (fault === "executor") {
            run.executorFence = { assertCurrent() {} };
          } else if (fault === "abort") {
            controller.abort(new Error("cancelled fixture"));
          } else {
            callerCurrent = false;
          }
        });
        await commands.restartRetainedUpdateGatewayService({
          ...request(run),
          signal: controller.signal,
          assertCurrent() {
            if (!callerCurrent) {
              throw new Error("changed original service");
            }
          },
        });
      });
      await expect(work).rejects.toThrow(
        /executor|ownership|cancelled fixture|changed original service/,
      );
      expect(futureConfig.assertFutureConfigActionAllowed).toHaveBeenCalledOnce();
      expect(native).not.toHaveBeenCalled();
    },
  );

  it.each(["A", "B"] as const)(
    "checks %s again after reset-failed and before restart",
    async (root) => {
      const native = vi.spyOn(systemdExec, "execSystemctlUser").mockImplementation(async () => {
        await Promise.resolve();
        revoke(root === "A" ? a : b);
        return success;
      });
      await expect(
        owned(async (run) => {
          await commands.restartRetainedUpdateGatewayService(request(run));
        }),
      ).rejects.toThrow();
      expect(native).toHaveBeenCalledOnce();
      expect(native.mock.calls[0]?.[1][0]).toBe("reset-failed");
    },
  );

  it.each(["same-root", "unretained", "forged"] as const)(
    "rejects a %s recovery before native inspection",
    async (fault) => {
      const native = vi.spyOn(systemdExec, "execSystemctlUser").mockResolvedValue(success);
      if (fault === "forged") {
        await expect(
          commands.restartRetainedUpdateGatewayService(
            request({
              runId: randomUUID(),
              env,
              executorFence: { assertCurrent() {} },
            }),
          ),
        ).rejects.toThrow(/admitted executor/);
      } else {
        await expect(
          owned(async (run) => {
            await commands.restartRetainedUpdateGatewayService(
              request(run, fault === "same-root" ? b : a),
            );
          }, fault !== "unretained"),
        ).rejects.toThrow(/retained executor root/);
      }
      expect(systemdScope.findInstalledSystemdGatewayScope).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
    },
  );

  it("retains native rejection rather than reporting completed or readiness", async () => {
    vi.spyOn(systemdExec, "execSystemctlUser").mockResolvedValue({
      ...success,
      code: 1,
      stderr: "native failed",
    });
    await expect(
      owned(async (run) => {
        await commands.restartRetainedUpdateGatewayService(request(run));
      }),
    ).rejects.toThrow("native failed");
  });

  it("does not release native operation lock while a nested native borrower is pending", async () => {
    const release = createDeferred();
    const entered = createDeferred();
    let borrower: Promise<void> | undefined;
    vi.spyOn(systemdExec, "execSystemctlUser").mockImplementation(async (_env, args) => {
      if (args[0] === "restart") {
        borrower = withGatewayServiceOperationLock(env, async (assertCurrent) => {
          entered.resolve();
          await release.promise;
          assertCurrent();
        });
        await entered.promise;
      }
      return success;
    });
    let done = false;
    const work = owned(async (run) => {
      await commands.restartRetainedUpdateGatewayService(request(run));
    }).then(() => {
      done = true;
    });
    try {
      await Promise.race([entered.promise, work]);
      await Promise.resolve();
      expect(done).toBe(false);
      for (const root of [a, b]) {
        expect(
          createManagedHandoffLeaseStore().acquire(root, randomUUID(), { kind: "update" }).kind,
        ).toBe("busy");
      }
      release.resolve();
      await work;
      await borrower;
    } finally {
      release.resolve();
      await work.catch(() => undefined);
    }
  });

  it.each(["healthy", "A", "B", "A-child"] as const)(
    "retained-root query uses actual delegated authority: %s",
    async (fault) => {
      const proceed = path.join(a, "proceed");
      const effect = path.join(a, "delegated-effect");
      const ownerUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor);
      const sourceArgs = ownerUrl.pathname.endsWith(".ts")
        ? ["--import", path.resolve("scripts/tsx.mjs")]
        : [];
      const script = `
      import fs from "node:fs";
      import {setTimeout} from "node:timers/promises";
      import {withDelegatedUpdateCommandExecutor,assertRetainedUpdateCommandRoot,captureUpdateCommandExecutorAuthority} from ${JSON.stringify(ownerUrl.href)};
      // The parent binds child identity before sending the grant; stdin can be nonblocking.
      process.stdin.setEncoding("utf8");
      let input="";
      for await(const chunk of process.stdin)input+=chunk;
      const {grant,a,b,proceed,effect}=JSON.parse(input);
      try {
        await withDelegatedUpdateCommandExecutor(grant,grant.runId,grant.root,async fence=>{
          assertRetainedUpdateCommandRoot(fence,a);
          if(captureUpdateCommandExecutorAuthority(fence).installKey!==b)throw Error("B identity lost");
          process.stdout.write("ADMITTED");
          while(!fs.existsSync(proceed))await setTimeout(10);
          assertRetainedUpdateCommandRoot(fence,a);
          fs.writeFileSync(effect,"live retained A with original B");
        });
      } catch(error) {process.stderr.write(error.message);process.exitCode=1;}
    `;
      let childAdmitted = false;
      const work = owned(async (run) => {
        const fence = run.executorFence;
        if (!fence) {
          throw new Error("Missing fixture fence");
        }
        const result = await withUpdateCommandExecutorChild(fence, b, (grant, beforeInput) =>
          runUtf8CommandWithTimeout(
            [process.execPath, ...sourceArgs, "--input-type=module", "-e", script],
            {
              input: JSON.stringify({ grant, a, b, proceed, effect }),
              beforeInput,
              timeoutMs: 15000,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
              onOutputChunk(chunk, stream) {
                if (!childAdmitted && stream === "stdout" && chunk.toString() === "ADMITTED") {
                  childAdmitted = true;
                  if (fault === "A" || fault === "B") {
                    revoke(fault === "A" ? a : b);
                  }
                  if (fault === "A-child") {
                    if (!grant.retainedChildKey) {
                      throw new Error("Missing retained fixture child");
                    }
                    revoke(grant.retainedChildKey);
                  }
                  fs.writeFileSync(proceed, "");
                }
              },
            },
          ),
        );
        expect(result.code, result.stderr).toBe(fault === "healthy" ? 0 : 1);
      });
      if (fault === "healthy") {
        await work;
        expect(fs.readFileSync(effect, "utf8")).toBe("live retained A with original B");
      } else {
        await expect(work).rejects.toThrow(/ownership|settle|release|cleanup/);
        expect(fs.existsSync(effect)).toBe(false);
      }
      expect(childAdmitted).toBe(true);
    },
  );
});
