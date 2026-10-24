import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
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
vi.mock("../../daemon/schtasks-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/schtasks-control.js")>()),
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
  vi.spyOn(systemdScope, "assertNoSystemGatewayOwnershipForActivation").mockResolvedValue();
  vi.spyOn(systemdExec, "assertSystemdAvailable").mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function revoke(root: string) {
  using db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
  expect(
    db
      .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
      .run("replacement", root).changes,
  ).toBe(1);
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
function owned<T>(
  operation: (run: NonNullable<UpdateCommandOptions["run"]>) => Promise<T>,
  retained = true,
) {
  const run: NonNullable<UpdateCommandOptions["run"]> = { runId: randomUUID(), env };
  return withUpdateCommandExecutor(run.runId, async (executor) => {
    run.executorFence = await executor.enter(b, retained ? { serviceRoot: a } : undefined);
    return await operation(run);
  });
}
function expectOwners(kind: "busy" | "absent") {
  const store = createManagedHandoffLeaseStore();
  for (const root of [a, b]) {
    if (kind === "busy") {
      expect(store.acquire(root, randomUUID(), { kind: "update" }).kind).toBe(kind);
    } else {
      expect(store.read(root)).toEqual({ kind });
    }
  }
}
function restartOwned() {
  return owned((run) => commands.restartRetainedUpdateGatewayService(request(run)));
}

describe.skipIf(process.platform === "win32")("retained POSIX native restart", () => {
  it("restarts retained A with a real child and keeps both owners until native drain", async ({
    signal,
  }) => {
    const effect = path.join(a, "effect");
    const receipts = await openFixtureReceiptChannel();
    const definition = path.join(a, "unit");
    fs.writeFileSync(definition, "original Node A and service definition");
    let pid = 0;
    let complete = false;
    let work: Promise<void> | undefined;
    const releaseChild = () => receipts.release("native", "release");
    // Directory notifications can coalesce. Keep readiness and release outside
    // native custody so a failed observer can still unblock the owned child.
    const started = receipts.waitFor("native", "pid:").then(async () => {
      pid = Number(fs.readFileSync(effect, "utf8"));
      await receipts.waitFor("native", `pid:${pid}:`);
      expect(pid).toBeGreaterThan(0);
      expect(pid).not.toBe(process.pid);
    });
    await runQaGatewayFixture(
      async () => {
        const native = vi
          .spyOn(systemdExec, "execSystemctlUser")
          .mockImplementation(async (_env, args, _timeout, assertCurrent) => {
            assertCurrent?.();
            assertGatewayServiceUpdateCurrent();
            if (args[0] === "reset-failed") {
              return success;
            }
            expect(args).toEqual(["restart", "fixture-A.service"]);
            return await execFileUtf8(process.execPath, [
              "--input-type=module",
              "-e",
              `
      import fs from "node:fs";
      ${fixtureReceiptClientSource(receipts.endpoint)}
        fs.writeFileSync(${JSON.stringify(effect + ".tmp")}, String(process.pid));
        fs.renameSync(${JSON.stringify(effect + ".tmp")}, ${JSON.stringify(effect)});
        sendReceipt("native", "pid:" + process.pid + ":");
        await awaitRelease("native", "release");
        process.stdout.write("drained");
    `,
            ]);
          });
        const running = owned(async (run) => {
          const onGatewayStartAttempted = vi.fn();
          expect(
            await commands.restartRetainedUpdateGatewayService({
              ...request(run),
              onGatewayStartAttempted,
              signal,
            }),
          ).toEqual({ outcome: "completed" });
          expect(onGatewayStartAttempted).toHaveBeenCalledOnce();
        }).then(() => {
          complete = true;
        });
        work = running;
        const observe = async () => {
          await withinTest(Promise.race([started, running]), signal);
          expect(complete).toBe(false);
          expectOwners("busy");
          expect(createManagedHandoffLeaseStore().read(c)).toEqual({ kind: "absent" });
        };
        try {
          await observe();
        } finally {
          releaseChild();
          await running.catch(() => undefined);
        }
        await running;
        expect(native.mock.calls.map((call) => call[1][0])).toEqual(["reset-failed", "restart"]);
        expect(fs.readFileSync(definition, "utf8")).toBe("original Node A and service definition");
        expectOwners("absent");
      },
      async () => {
        releaseChild();
        await work?.catch(() => undefined);
      },
      () => receipts.close(),
    );
  });

  it.each([
    "A",
    "B",
    "caller",
    "executor",
    "abort",
    "binding",
    "unavailable",
    "scope",
    "A after reset-failed",
    "B after reset-failed",
  ] as const)("rechecks retained authority before restart: %s", async (fault) => {
    const native = vi.spyOn(systemdExec, "execSystemctlUser").mockResolvedValue(success);
    const afterReset = fault.endsWith("after reset-failed");
    if (afterReset) {
      native.mockImplementation(async () => {
        await Promise.resolve();
        revoke(fault.startsWith("A") ? a : b);
        return success;
      });
    }
    const controller = new AbortController();
    let callerCurrent = true;
    const onGatewayStartAttempted = vi.fn();
    let revalidations = 0;
    if (fault === "unavailable") {
      vi.mocked(systemdExec.assertSystemdAvailable).mockRejectedValue(new Error("unavailable"));
    } else if (fault === "scope") {
      vi.mocked(systemdScope.findInstalledSystemdGatewayScope).mockRejectedValue(
        new Error("scope"),
      );
    }
    const work = owned(async (run) => {
      if (!afterReset) {
        vi.spyOn(futureConfig, "assertFutureConfigActionAllowed").mockImplementation(async () => {
          await Promise.resolve();
          if (fault === "A" || fault === "B") {
            revoke(fault === "A" ? a : b);
          } else if (fault === "executor") {
            run.executorFence = { assertCurrent() {} };
          } else if (fault === "abort") {
            controller.abort(new Error("cancelled fixture"));
          } else if (fault === "caller") {
            callerCurrent = false;
          }
        });
      }
      await commands.restartRetainedUpdateGatewayService({
        ...request(run),
        onGatewayStartAttempted,
        revalidate: async () => {
          if (++revalidations === 2 && fault === "binding") {
            throw new Error("changed original service binding");
          }
        },
        signal: controller.signal,
        assertCurrent() {
          if (!callerCurrent) {
            throw new Error("changed original service");
          }
        },
      });
    });
    await expect(work).rejects.toThrow(
      /executor|ownership|cancelled fixture|changed original service|unavailable|scope/,
    );
    expect(native.mock.calls.map((call) => call[1][0])).toEqual(afterReset ? ["reset-failed"] : []);
    if (!afterReset) {
      expect(futureConfig.assertFutureConfigActionAllowed).toHaveBeenCalledOnce();
    }
    expect(onGatewayStartAttempted).not.toHaveBeenCalled();
  });

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
    await expect(restartOwned()).rejects.toThrow("native failed");
  });

  it("holds the native lock until its nested borrower settles", async () => {
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
    const work = restartOwned().then(() => {
      done = true;
    });
    try {
      await Promise.race([entered.promise, work]);
      await Promise.resolve();
      expect(done).toBe(false);
      expectOwners("busy");
      release.resolve();
      await work;
      await borrower;
    } finally {
      release.resolve();
      await work.catch(() => undefined);
    }
  });

  it("retained-root query uses actual delegated authority", async () => {
    const effect = path.join(a, "delegated-effect");
    const ownerUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor);
    const sourceArgs = ownerUrl.pathname.endsWith(".ts")
      ? ["--import", path.resolve("scripts/tsx.mjs")]
      : [];
    const script = `
      import fs from "node:fs";
      import {json} from "node:stream/consumers";
      import {withDelegatedUpdateCommandExecutor,assertRetainedUpdateCommandRoot,captureUpdateCommandExecutorAuthority} from ${JSON.stringify(ownerUrl.href)};
      const {grant,a,b,effect}=await json(process.stdin);
      await withDelegatedUpdateCommandExecutor(grant,grant.runId,grant.root,async fence=>{
        assertRetainedUpdateCommandRoot(fence,a);
        if(captureUpdateCommandExecutorAuthority(fence).installKey!==b)throw Error("B identity lost");
        fs.writeFileSync(effect,"live retained A with original B");
      });
    `;
    await owned(async (run) => {
      const fence = run.executorFence;
      if (!fence) {
        throw new Error("Missing fixture fence");
      }
      const result = await withUpdateCommandExecutorChild(fence, b, (grant, beforeInput) =>
        runUtf8CommandWithTimeout(
          [process.execPath, ...sourceArgs, "--input-type=module", "-e", script],
          {
            input: JSON.stringify({ grant, a, b, effect }),
            beforeInput,
            timeoutMs: 15000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          },
        ),
      );
      expect(result.code, result.stderr).toBe(0);
    });
    expect(fs.readFileSync(effect, "utf8")).toBe("live retained A with original B");
  });
});
