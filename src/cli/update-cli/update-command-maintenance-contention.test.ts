import "./update-command-execution.test-support.js";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { UpdateRecoveryRequiredError } from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import * as sleeping from "../../utils/sleep.js";
import { createGatewayRestartDeadline } from "../daemon-cli/restart-health-deadline.js";
import type { UpdateCommandOptions } from "./shared.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { updateExecutorNativeEntrypoints as native } from "./update-command-executor-native-runtime.test-support.js";

const { bindExecutionGuards, executionParams, mocks, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

const temporary = useAutoCleanupTempDirTracker(afterAll);
let child: ChildProcess;
let exited: Promise<unknown>;
let stderr = "";
let currentOptions: UpdateCommandOptions | undefined;

async function request(message: object) {
  const reply = once(child, "message");
  child.send(message);
  return await Promise.race([
    reply,
    exited.then(() => {
      throw new Error(`Maintenance fixture exited: ${stderr}`);
    }),
  ]);
}

beforeAll(async () => {
  const root = temporary.make("update-maintenance-child-");
  const lockUrl = resolveRuntimeWorkerUrl(native.gatewayLock);
  child = spawn(
    resolveTestNodeExecPath(),
    [
      ...(lockUrl.pathname.endsWith(".ts") ? ["--import", path.resolve("scripts/tsx.mjs")] : []),
      "--input-type=module",
      "--eval",
      `const { acquireGatewayLock } = await import(${JSON.stringify(lockUrl.href)});
       const { createRetainedUpdateRecovery } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(native.retainedRecovery).href)});
       let lock;
       process.on('message', async message => {
         if (message.acquire) {
           lock = await acquireGatewayLock({env:message.acquire,role:'sqlite-maintenance',allowInTests:true,timeoutMs:0});
           if (!lock) throw new Error('Missing native maintenance owner');
         } else if (message.recover) {
           const from = {root:message.root,nodePath:process.execPath,version:'1.0.0',buildId:null};
           lock.run(() => createRetainedUpdateRecovery({runId:message.recover,from,to:{...from,version:'2.0.0'}},{env:message.env}));
         } else if (message.release) {
           await lock?.release(); lock = undefined;
         } else if (message.exit) {
           await lock?.release(); process.disconnect(); return;
         }
         process.send({ready:true,pid:process.pid});
       });`,
    ],
    {
      env: { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  exited = once(child, "exit");
});

afterAll(async () => {
  await closeOpenClawStateDatabaseAsync();
  child?.send({ exit: true });
  await exited;
});

afterEach(async () => {
  currentOptions?.run?.deadline?.dispose();
  currentOptions = undefined;
  await request({ release: true });
});

async function fixture() {
  const root = temporary.make("update-maintenance-state-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const { runId } = createUpdateRun({ trigger: "cli" }, { env });
  await closeOpenClawStateDatabaseAsync();
  const opts: UpdateCommandOptions = { json: true, run: { runId, env } };
  currentOptions = opts;
  const guard = createUpdateCommandExecutionGuards(opts, root);
  return { root, env, runId, opts, guard };
}

it("reproduces native recovery refusal and proceeds only after the real foreign owner releases", async () => {
  const f = await fixture();
  f.guard.assertCurrent();
  await request({ acquire: f.env });
  expect(() => f.guard.assertCurrent()).toThrow("undergoing offline maintenance");
  const wait = vi.spyOn(sleeping, "sleep").mockImplementation(async () => {
    await request({ release: true });
  });
  await f.guard.waitForCurrent();
  expect(wait).toHaveBeenCalledOnce();
  f.guard.assertCurrent();
});

it.each(["before-stop", "before-checkout", "held-before-checkout"] as const)(
  "defers a held owner %s and waits for a transient owner before checkout",
  async (arrival) => {
    const f = await fixture();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const wait = vi.spyOn(sleeping, "sleep").mockImplementation(async (ms) => {
      if (arrival !== "before-checkout") {
        now += 30_000 + ms;
      } else {
        await request({ release: true });
      }
    });
    let checkedOut = false;
    const acquire = async () => {
      await closeOpenClawStateDatabaseAsync();
      await request({ acquire: f.env });
      expect(() => f.guard.assertCurrent()).toThrow("undergoing offline maintenance");
    };
    mocks.runGitUpdate.mockImplementation(async (options) => {
      await options.validateCandidate("/candidate");
      if (arrival === "before-stop") {
        await acquire();
      }
      await options.beforeGitMutation({});
      if (arrival !== "before-stop") {
        await acquire();
        await options.inspectGitTarget({});
      }
      checkedOut = true;
      return { ...successfulUpdate, mode: "git" };
    });
    const result = await executeMutableUpdate(
      await bindExecutionGuards({ ...executionParams("git"), root: f.root, opts: f.opts }),
    );
    if (arrival !== "before-checkout") {
      expect(result?.result, result?.failure?.detail).toMatchObject({
        reason: "state-maintenance-busy",
        recovery: { serviceRestartSafe: true },
      });
      expect(result?.failure?.detail).toContain(`sqlite-maintenance process ${child.pid}`);
      expect(result?.failure?.detail).toContain("retry openclaw update");
    } else {
      expect(result?.result.status, result?.failure?.detail).toBe("ok");
    }
    expect(wait).toHaveBeenCalled();
    expect(mocks.serviceStopped).toBe(arrival !== "before-stop");
    expect(checkedOut).toBe(arrival === "before-checkout");
  },
);

it.each(["recovery", "revocation", "interruption", "deadline"] as const)(
  "preserves fresh %s while maintenance is pending",
  async (change) => {
    const f = await fixture();
    let authorized = true;
    f.opts.run!.requesterAuthority = { requester: {}, isCurrent: () => authorized };
    const guard = createUpdateCommandExecutionGuards(f.opts, f.root);
    await request({ acquire: f.env });
    let now = 0;
    if (change === "deadline") {
      vi.spyOn(performance, "now").mockImplementation(() => now);
      f.opts.run!.deadline = createGatewayRestartDeadline({ timeoutMs: 30_000 });
    }
    const sleep = sleeping.sleep;
    vi.spyOn(sleeping, "sleep").mockImplementation(async () => {
      if (change === "recovery") {
        await request({ recover: f.runId, env: f.env, root: f.root });
        await request({ release: true });
      } else if (change === "revocation") {
        authorized = false;
      } else if (change === "interruption") {
        f.opts.run!.interrupted = true;
      } else {
        now = 30_001;
        f.opts.run!.deadline!.remainingMs();
        await sleep(1, f.opts.run!.deadline!.signal);
      }
    });
    if (change === "deadline") {
      await expect(guard.waitForCurrent()).rejects.toMatchObject({
        reason: "state-maintenance-busy",
        message: expect.stringContaining(`sqlite-maintenance process ${child.pid}`),
      });
    } else {
      await expect(guard.waitForCurrent()).rejects.toBeInstanceOf(
        change === "recovery" ? UpdateRecoveryRequiredError : UpdateRequesterRevokedError,
      );
    }
  },
);
