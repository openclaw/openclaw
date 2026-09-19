import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import * as sqliteLocation from "../../infra/node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "../../infra/update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "../../infra/update-managed-service-handoff-runtime.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import * as windowsProcess from "../../infra/windows-port-pids.js";
import { isChildProcessTreeAlive } from "../../process/child-process-tree.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import * as pidAlive from "../../shared/pid-alive.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  captureUpdateCommandExecutorAuthority,
  releaseUpdateCommandPreflightForHandoff,
  withDelegatedUpdateCommandExecutor,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let temporary: string;
beforeEach(() => {
  root = fs.realpathSync(dirs.make("update-executor-"));
  temporary = path.join(root, "private-tmp");
  fs.mkdirSync(temporary, { mode: 0o700 });
  // Select only the private database location; the lease, process-start checks,
  // and exact-row comparisons are the production owner.
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// The installed parent prepares the database before a sealed actor can acquire a lease.
function prepareStagedLeaseFixture() {
  const databasePath = path.join(temporary, "managed-update-handoffs.sqlite");
  const existingIdentity = createManagedHandoffLeaseDatabase(databasePath)(true, () =>
    captureManagedUpdateLeaseDatabaseIdentity(databasePath),
  );
  stageManagedHandoffRuntime(root);
  return {
    runtimeEntry: path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY),
    options: { databasePath, serviceManagerEnv: resolveServiceManagerEnv(), existingIdentity },
  };
}

function replaceOwner(installationRoot = root) {
  const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
  try {
    db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
      "replacement",
      installationRoot,
    );
  } finally {
    db.close();
  }
}

describe("live update executor", () => {
  it("finishes an attributed Windows candidate and records its missing start identity warning", async () => {
    const hostPlatform = process.platform;
    const existingUri = sqliteLocation.resolveExistingSqliteFileUri;
    // Keep SQLite on the host VFS while exercising Windows process identity.
    vi.spyOn(sqliteLocation, "resolveExistingSqliteFileUri").mockImplementation((pathname) =>
      existingUri(pathname, hostPlatform),
    );
    const env = { HOME: root, OPENCLAW_STATE_DIR: root };
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const run = createUpdateRun({ trigger: "cli" }, { env });
    const candidatePid = 424242;
    const argv = [
      "C:\\node.exe",
      "C:\\openclaw\\entry.js",
      "gateway",
      "install",
      "--update-executor",
      "check",
    ];
    const readStart = pidAlive.getFileLockProcessStartTime;
    const isDead = pidAlive.isPidDefinitelyDead;
    let candidateAlive = true;
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockImplementation((pid, ...args) =>
      pid === candidatePid ? null : readStart(pid, ...args),
    );
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockImplementation((pid) =>
      pid === candidatePid ? !candidateAlive : isDead(pid),
    );
    vi.spyOn(windowsProcess, "readWindowsProcessArgsSync").mockReturnValue(argv);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      const fence = await executor.enter(root);
      await withMockedPlatform("win32", () =>
        withUpdateCommandExecutorChild(fence, root, async (_grant, bindChild) => {
          try {
            bindChild(candidatePid, argv);
          } finally {
            candidateAlive = false;
          }
        }),
      );
      fence.assertCurrent();
    });
    finishUpdateRun(run.runId, { status: "succeeded" }, { env });
    const recorded = getUpdateRun(run.runId, { env });
    assert(recorded);
    expect(recorded.status).toBe("succeeded");
    expect(recorded.steps).toContainEqual(
      expect.objectContaining({
        step: `warning:process-start-identity:${candidatePid}`,
        status: "completed",
        detail: expect.stringContaining("launcher attribution"),
      }),
    );
    expect(renderUpdateRunReport(recorded).markdown).toContain("launcher attribution");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(String(candidatePid)));
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  });

  it("recovery acquires a fresh owner without reactivating the original fence", async () => {
    const store = createManagedHandoffLeaseStore();
    const runId = randomUUID();
    const original = await withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root);
      const current = store.read(root);
      assert(current.kind === "current", "Original executor was not acquired");
      return {
        fence,
        lease: current.lease,
        authority: captureUpdateCommandExecutorAuthority(fence),
      };
    });
    expect(Object.isFrozen(original.authority)).toBe(true);
    expect(original.authority.owner).toBe(original.lease.owner);
    expect(() => captureUpdateCommandExecutorAuthority(original.fence)).toThrow(
      "no longer current",
    );
    await withUpdateCommandExecutor(
      runId,
      async (executor) => {
        const fence = await executor.enter(root);
        const current = store.read(root);
        assert(current.kind === "current", "Recovery executor was not acquired");
        expect(current.lease.owner).not.toBe(original.lease.owner);
        expect(current.lease.helper.pid).toBe(process.pid);
        const recoveredAuthority = captureUpdateCommandExecutorAuthority(fence);
        expect(recoveredAuthority).toEqual({
          ...original.authority,
          owner: current.lease.owner,
        });
        expect(recoveredAuthority.owner).not.toBe(original.authority.owner);
        expect(Object.isFrozen(recoveredAuthority)).toBe(true);
        expect(store.current(original.lease)).toBe(false);
        expect(store.release(original.lease)).toBe(false);
        expect(original.fence.assertCurrent).toThrow("no longer current");
        fence.assertCurrent();
      },
      { existingAuthority: original.authority },
    );
    expect(store.read(root)).toEqual({ kind: "absent" });
  });

  it("recovery keeps the admitted installation key when the package root is missing", async () => {
    const packageRoot = path.join(root, "package");
    fs.mkdirSync(packageRoot);
    const authority = await withUpdateCommandExecutor(randomUUID(), async (executor) =>
      captureUpdateCommandExecutorAuthority(await executor.enter(packageRoot)),
    );
    fs.rmdirSync(packageRoot);
    await withUpdateCommandExecutor(
      randomUUID(),
      async (executor) => {
        const fence = await executor.enter(packageRoot);
        fence.assertCurrent();
        await expect(executor.enter(root)).rejects.toThrow("installation key changed");
        const { owner: originalOwner, ...originalBinding } = authority;
        const { owner: recoveredOwner, ...recoveredBinding } =
          captureUpdateCommandExecutorAuthority(fence);
        expect(recoveredBinding).toEqual(originalBinding);
        expect(recoveredOwner).not.toBe(originalOwner);
        expect(createManagedHandoffLeaseStore().read(packageRoot)).toMatchObject({
          kind: "current",
          lease: { owner: recoveredOwner },
        });
      },
      { existingAuthority: authority },
    );
    expect(fs.existsSync(packageRoot)).toBe(false);
    expect(createManagedHandoffLeaseStore().read(packageRoot)).toEqual({ kind: "absent" });
  });

  it("retires the direct preflight owner before a supervised helper independently acquires", async () => {
    const store = createManagedHandoffLeaseStore();
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root, { preflight: true });
      const original = store.read(root);
      expect(original.kind).toBe("current");
      releaseUpdateCommandPreflightForHandoff(fence);
      expect(fence.assertCurrent).toThrow("no longer current");
      expect(store.read(root)).toEqual({ kind: "absent" });
      const acquired = store.acquire(root, "independent-helper", { kind: "update" });
      expect(acquired.kind).toBe("acquired");
      await expect(executor.enter(root)).rejects.toThrow("closed or busy");
      expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("not current");
      if (acquired.kind === "acquired") {
        expect(store.release(acquired.lease)).toBe(true);
      }
    });
  });

  it("closes preflight release on mutable admission without revoking its current owner", async () => {
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root, { preflight: true });
      expect(await executor.enter(root)).toBe(fence);
      expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("not current");
      expect(fence.assertCurrent).not.toThrow();
    });
  });

  it("refuses to release a replaced preflight owner and preserves the new lease", async () => {
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root, { preflight: true });
        replaceOwner();
        expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("no longer current");
        const observed = createManagedHandoffLeaseStore().read(root);
        expect(observed).toMatchObject({ kind: "current", lease: { owner: "replacement" } });
      }),
    ).rejects.toThrow();
  });

  it("reclaims a dead direct executor through the existing process-liveness owner", async () => {
    const { runtimeEntry, options } = prepareStagedLeaseFixture();
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
      const store=createManagedHandoffLeaseStore(${JSON.stringify(options)});
      if(store.acquire(${JSON.stringify(root)},"dead-executor",{kind:"update"}).kind!=="acquired")throw new Error("admission failed");
    `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(createManagedHandoffLeaseStore().read(root).kind).toBe("current");
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      fence.assertCurrent();
    });
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  });

  it("borrows only a live helper's exact assigned executor and leaves release to that helper", async () => {
    const { runtimeEntry, options } = prepareStagedLeaseFixture();
    const runId = randomUUID();
    const owner = randomUUID();
    const metadata = path.join(root, "handoff.json");
    fs.writeFileSync(
      metadata,
      JSON.stringify({ version: 1, meta: { runId, handoffId: owner, root } }),
    );
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
    vi.stubEnv(CONTROL_PLANE_UPDATE_SENTINEL_META_ENV, metadata);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
      const store=createManagedHandoffLeaseStore(${JSON.stringify(options)});
      const acquired=store.acquire(${JSON.stringify(root)},${JSON.stringify(owner)},{kind:"update"});
      if(acquired.kind!=="acquired")throw new Error("helper admission failed");
      const assigned=store.bind(acquired.lease,${process.pid});
      if(!assigned)throw new Error("helper assignment failed");
      process.once("message",()=>{
        const local=store.bind(assigned,process.pid);
        if(!local||!store.release(local))throw new Error("helper release failed");
        process.disconnect();
      });
      process.send("assigned");
    `,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    try {
      const ready = await Promise.race([
        once(child, "message").then(([message]) => message),
        exited.then(() => {
          throw new Error(`helper exited before assignment: ${stderr}`);
        }),
      ]);
      expect(ready).toBe("assigned");
      const store = createManagedHandoffLeaseStore();
      await withUpdateCommandExecutor(runId, async (executor) => {
        const fence = await executor.enter(root, { preflight: true });
        expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("not current");
        await Promise.resolve();
        fence.assertCurrent();
      });
      const current = store.read(root);
      expect(current.kind === "current" && current.lease.owner).toBe(owner);
      await expect(
        withUpdateCommandExecutor(randomUUID(), async (executor) => executor.enter(root)),
      ).rejects.toThrow("changed during admission");
      expect(store.read(root)).toEqual(current);
    } finally {
      if (child.connected) {
        child.send("release");
      }
      const [code] = await exited;
      expect(code, stderr).toBe(0);
    }
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  });

  it("preserves an unreadable existing coordination database without repairing it", async () => {
    const database = path.join(temporary, "managed-update-handoffs.sqlite");
    fs.writeFileSync(database, "unreadable native owner", { mode: 0o600 });
    const before = fs.readFileSync(database);
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => executor.enter(root)),
    ).rejects.toThrow("state is unreadable");
    expect(fs.readFileSync(database)).toEqual(before);
  });

  it("does not open the coordination database for a read-only or no-op invocation", async () => {
    await withUpdateCommandExecutor(randomUUID(), async () => "preview");
    expect(fs.readdirSync(temporary)).toEqual([]);
  });

  it("holds the existing owner across awaited execution and refuses a second local invocation", async () => {
    const admitted = createDeferred();
    const settle = createDeferred();
    const runId = randomUUID();
    let retained: UpdateRecoveryFence | undefined;
    const running = withUpdateCommandExecutor(runId, async (executor) => {
      retained = await executor.enter(root);
      retained.assertCurrent();
      admitted.resolve();
      await settle.promise;
      retained.assertCurrent();
      return "completed";
    });
    try {
      await admitted.promise;
      const store = createManagedHandoffLeaseStore();
      expect(store.read(root).kind).toBe("current");
      await expect(
        withUpdateCommandExecutor(runId, async (other) => other.enter(root)),
      ).rejects.toThrow("Another update executor");
      retained!.assertCurrent();
    } finally {
      settle.resolve();
    }
    await expect(running).resolves.toBe("completed");
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
    expect(() => retained!.assertCurrent()).toThrow("no longer current");
  });

  it("rejects a changed native-owner row after an await without removing the replacement", async () => {
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        await Promise.resolve();
        replaceOwner();
        fence.assertCurrent();
      }),
    ).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
    const current = createManagedHandoffLeaseStore().read(root);
    expect(current.kind === "current" && current.lease.owner).toBe("replacement");
  });

  it("preserves the primary error and releases only its own exact owner", async () => {
    const primary = new Error("package failed");
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await executor.enter(root);
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  });

  it("closes saved admission methods without minting a later owner", async () => {
    const saved = await withUpdateCommandExecutor(randomUUID(), async (executor) => executor);
    await expect(saved.enter(root)).rejects.toThrow("admission is closed");
    expect(fs.readdirSync(temporary)).toEqual([]);
  });

  it("pins the originally admitted installation for the full invocation", async () => {
    const moved = path.join(root, "different-install");
    fs.mkdirSync(moved);
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      await expect(executor.enter(moved)).rejects.toThrow("installation changed");
      fence.assertCurrent();
    });
    expect(createManagedHandoffLeaseStore().read(moved)).toEqual({ kind: "absent" });
  });
});

describe("candidate executor delegation", () => {
  const moduleUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor).href;
  it.each([
    { mismatched: false, becomesReadable: false, revoked: false },
    { mismatched: true, becomesReadable: false, revoked: false },
    { mismatched: false, becomesReadable: true, revoked: false },
    { mismatched: false, becomesReadable: false, revoked: true },
  ])(
    "consumes the parent's bound creation identity when the Windows receiver cannot read its own (mismatch=$mismatched, fallback becomes readable=$becomesReadable, revoked=$revoked)",
    async ({ mismatched, becomesReadable, revoked }) => {
      const hostPlatform = process.platform;
      const existingUri = sqliteLocation.resolveExistingSqliteFileUri;
      vi.spyOn(sqliteLocation, "resolveExistingSqliteFileUri").mockImplementation((pathname) =>
        existingUri(pathname, hostPlatform),
      );
      const readStart = pidAlive.getFileLockProcessStartTime;
      const parentStart = readStart(process.ppid);
      const receiverStart = readStart(process.pid);
      assert(parentStart !== null);
      assert(receiverStart !== null);
      const store = createManagedHandoffLeaseStore();
      const runId = randomUUID();
      const childKey = `${root}/.openclaw-update-child-${randomUUID()}`;
      assert(store.acquire(root, randomUUID(), { kind: "update" }).kind === "acquired");
      assert(store.acquire(childKey, runId, { kind: "update" }).kind === "acquired");
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      let currentReceiverStart = mismatched ? receiverStart + 1 : null;
      vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockImplementation((pid, ...args) => {
        if (pid === process.pid) {
          return currentReceiverStart;
        }
        if (pid === process.ppid) {
          return parentStart;
        }
        platform.mockReturnValue(hostPlatform);
        try {
          return readStart(pid, ...args);
        } finally {
          platform.mockReturnValue("win32");
        }
      });
      const parentIdentity = { pid: process.ppid, startIdentity: String(parentStart) };
      const receiverIdentity =
        becomesReadable || revoked
          ? createManagedHandoffLeaseStore().processIdentity()
          : { pid: process.pid, startIdentity: String(receiverStart) };
      const databasePath = path.join(temporary, "managed-update-handoffs.sqlite");
      const db = new DatabaseSync(databasePath);
      try {
        // Reproduce the rows already bound by the parent before releasing private stdin.
        const update = db.prepare(
          "UPDATE managed_update_handoffs SET payload_json = ? WHERE install_root = ?",
        );
        for (const [key, executor] of [
          [root, parentIdentity],
          [childKey, receiverIdentity],
        ] as const) {
          update.run(
            JSON.stringify({
              version: 2,
              helper: parentIdentity,
              executor,
              action: { kind: "update" },
            }),
            key,
          );
        }
      } finally {
        db.close();
      }
      const parent = store.read(root);
      assert(parent.kind === "current");
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const effectPath = path.join(root, "authorized-effect");
      let nestedStarted = false;
      const operation = vi.fn(async (fence: UpdateRecoveryFence) => {
        fence.assertCurrent();
        if (becomesReadable) {
          currentReceiverStart = receiverStart;
        }
        if (revoked) {
          replaceOwner();
        }
        let nestedKey: string | undefined;
        await withUpdateCommandExecutorChild(fence, root, async (grant, bindChild) => {
          nestedStarted = true;
          nestedKey = grant.childKey;
          const candidate = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
            stdio: ["pipe", "ignore", "ignore"],
          });
          const exited = once(candidate, "exit");
          try {
            await once(candidate, "spawn");
            assert(candidate.pid);
            bindChild(candidate.pid, candidate.spawnargs);
            const nested = store.read(grant.childKey);
            assert(nested.kind === "current");
            expect(nested.lease.helper).toEqual(receiverIdentity);
            candidate.stdin.end();
            await exited;
          } finally {
            if (candidate.exitCode === null && candidate.signalCode === null) {
              candidate.kill("SIGKILL");
            }
            await exited;
          }
        });
        assert(nestedKey);
        expect(store.read(nestedKey)).toEqual({ kind: "absent" });
        fence.assertCurrent();
        fs.writeFileSync(effectPath, "owned");
        return "completed";
      });
      const result = withDelegatedUpdateCommandExecutor(
        { runId, root, databasePath, parent: parent.lease, childKey },
        runId,
        root,
        operation,
      );
      if (mismatched) {
        await expect(result).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
      } else if (revoked) {
        await expect(result).rejects.toThrow(
          /ownership|Unable to finish stopping the update process and its children/,
        );
      } else {
        await expect(result).resolves.toBe("completed");
      }
      expect(operation).toHaveBeenCalledTimes(mismatched ? 0 : 1);
      expect(nestedStarted).toBe(!mismatched && !revoked);
      expect(fs.existsSync(effectPath)).toBe(!mismatched && !revoked);
      if (!mismatched && !becomesReadable && !revoked) {
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining("established by the live parent"),
        );
      }
    },
  );

  it("refuses a revoked requester before delegated Doctor changes operator config", async () => {
    const configPath = path.join(root, "openclaw.json");
    const original = JSON.stringify({
      commands: { ownerAllowFrom: ["replacement"] },
      plugins: { enabled: false },
    });
    fs.writeFileSync(configPath, original);
    const workerUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.migratedFinalize);
    const resultUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.doctorResult);
    // Prepare the worker before its deadline; watch mode still loads live source.
    const sourceImportArgs = workerUrl.pathname.endsWith(".ts")
      ? ["--import", path.resolve("scripts/tsx.mjs")]
      : [];
    const childProgram = `
      import fs from "node:fs";
      import {createUpdatePostInstallDoctorResultPath, UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV} from ${JSON.stringify(resultUrl.href)};
      const resultPath = createUpdatePostInstallDoctorResultPath();
      process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV] = resultPath;
      process.argv[2] = "--doctor";
      process.once("exit", () => {
        if (fs.existsSync(resultPath)) {
          process.stdout.write(fs.readFileSync(resultPath, "utf8"));
          fs.rmSync(resultPath);
        }
      });
      await import(${JSON.stringify(workerUrl.href)});
    `;
    const runId = randomUUID();
    await withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root);
      const result = await withUpdateCommandExecutorChild(fence, root, (grant, beforeInput) =>
        runUtf8CommandWithTimeout(
          [process.execPath, ...sourceImportArgs, "--input-type=module", "-e", childProgram],
          {
            input: JSON.stringify({
              executor: grant,
              runId,
              root,
              configInputHash: createHash("sha256").update(original).digest("hex"),
              requester: { channel: "synthetic", senderId: "owner" },
              repair: true,
            }),
            beforeInput,
            env: { HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath },
            timeoutMs: 15_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          },
        ),
      );
      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout, result.stderr).toContain('"reason":"requester-revoked"');
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "error",
        configWriteRefusal: { reason: "requester-revoked", keys: [] },
      });
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
      fence.assertCurrent();
    });
  });

  const program = `
    import fs from "node:fs";
    import {spawn} from "node:child_process";
    import {once} from "node:events";
    import {setTimeout} from "node:timers/promises";
    import {withDelegatedUpdateCommandExecutor} from ${JSON.stringify(moduleUrl)};
    const input=JSON.parse(fs.readFileSync(0,"utf8"));
    await withDelegatedUpdateCommandExecutor(input.grant,input.grant.runId,input.root,async (fence)=>{
      process.stdout.write("admitted\\n");
      while(!fs.existsSync(input.proceed)) await setTimeout(10);
      fence.assertCurrent();
      fs.writeFileSync(input.output,"owned");
      const helper=spawn(process.execPath,['-e',"process.send('ready');setTimeout(()=>{},2000)"],{
        stdio:['ignore','ignore','ignore','ipc']
      });
      await once(helper,'message');
      helper.disconnect();
      helper.unref();
    });
  `;
  it.each([
    { changedRoot: false, revoked: false },
    { changedRoot: false, revoked: "candidate" },
    { changedRoot: true, revoked: false },
    { changedRoot: true, revoked: "candidate" },
    { changedRoot: true, revoked: "original" },
  ])(
    "retains both installation owners through a real child ($changedRoot, $revoked)",
    async ({ changedRoot, revoked }) => {
      const candidateRoot = changedRoot ? path.join(root, "activated") : root;
      if (changedRoot) {
        fs.mkdirSync(candidateRoot);
      }
      const ready = createDeferred();
      const proceed = path.join(root, "proceed");
      const output = path.join(root, "effect");
      const work = withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        const pending = withUpdateCommandExecutorChild(fence, candidateRoot, (grant, beforeInput) =>
          runUtf8CommandWithTimeout(
            [
              process.execPath,
              "--import",
              path.resolve("scripts/tsx.mjs"),
              "--input-type=module",
              "-e",
              program,
            ],
            {
              input: JSON.stringify({ grant, root: candidateRoot, proceed, output }),
              beforeInput,
              timeoutMs: 15_000,
              killProcessTree: true,
              // Match production candidate transport: join source-loader helpers too.
              requireProcessTreeExtinction: true,
              onOutputChunk: (chunk) => {
                if (chunk.toString().includes("admitted")) {
                  ready.resolve();
                }
              },
            },
          ),
        );
        try {
          await Promise.race([
            ready.promise,
            pending.then((result) => {
              throw new Error(`Candidate exited before admission: ${JSON.stringify(result)}`);
            }),
          ]);
          expect(() => fence.assertCurrent()).toThrow("The update process is still running.");
          const store = createManagedHandoffLeaseStore();
          const primary = store.read(root);
          expect(primary.kind).toBe("current");
          if (primary.kind !== "current") {
            throw new Error("missing primary owner");
          }
          expect(store.release(primary.lease)).toBe(false);
          expect(store.bind(primary.lease, process.pid)).toBeNull();
          expect(store.acquire(candidateRoot, "other-candidate", { kind: "update" }).kind).toBe(
            "busy",
          );
          if (revoked) {
            replaceOwner(revoked === "original" ? root : candidateRoot);
          }
        } finally {
          fs.writeFileSync(proceed, "continue");
        }
        const result = await pending;
        expect(result.code, result.stderr).toBe(0);
        fence.assertCurrent();
      });
      if (revoked) {
        await expect(work).rejects.toThrow(/ownership|release/);
        // The current receiver also retains the original recovery owner after
        // activation: changing either owner must refuse the child effect.
        expect(fs.existsSync(output)).toBe(false);
        expect(
          createManagedHandoffLeaseStore().read(revoked === "original" ? root : candidateRoot),
        ).toMatchObject({
          kind: "current",
          lease: { owner: "replacement" },
        });
        if (changedRoot && revoked === "candidate") {
          expect(
            createManagedHandoffLeaseStore().acquire(root, "next-original", { kind: "update" })
              .kind,
          ).toBe("busy");
        }
        if (revoked === "original") {
          expect(createManagedHandoffLeaseStore().read(candidateRoot)).toEqual({ kind: "absent" });
        }
      } else {
        await work;
        expect(fs.readFileSync(output, "utf8")).toBe("owned");
        expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
        expect(createManagedHandoffLeaseStore().read(candidateRoot)).toEqual({ kind: "absent" });
      }
    },
  );

  it("does not expose a grant when another owner holds the activated installation", async () => {
    const candidateRoot = path.join(root, "activated");
    const output = path.join(root, "exposed-grant");
    fs.mkdirSync(candidateRoot);
    const store = createManagedHandoffLeaseStore();
    const foreign = store.acquire(candidateRoot, "foreign-candidate", { kind: "update" });
    assert(foreign.kind === "acquired", "Foreign candidate owner was not acquired");
    try {
      await expect(
        withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(root);
          await withUpdateCommandExecutorChild(fence, candidateRoot, async () => {
            fs.writeFileSync(output, "exposed");
          });
        }),
      ).rejects.toThrow("owns the update installation");
      expect(fs.existsSync(output)).toBe(false);
      expect(store.current(foreign.lease)).toBe(true);
      expect(store.read(root)).toEqual({ kind: "absent" });
    } finally {
      expect(store.release(foreign.lease)).toBe(true);
    }
  });

  it("withholds candidate input when the original owner changes before process binding", async () => {
    const candidateRoot = path.join(root, "activated");
    const output = path.join(root, "effect");
    fs.mkdirSync(candidateRoot);
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        await withUpdateCommandExecutorChild(fence, candidateRoot, (grant, beforeInput) =>
          runUtf8CommandWithTimeout(
            [
              process.execPath,
              "--import",
              path.resolve("scripts/tsx.mjs"),
              "--input-type=module",
              "-e",
              program,
            ],
            {
              input: JSON.stringify({ grant, root: candidateRoot, output }),
              beforeInput: (pid) => {
                replaceOwner();
                beforeInput(pid);
              },
              timeoutMs: 15_000,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
            },
          ),
        );
      }),
    ).rejects.toThrow(/ownership|release/);
    expect(fs.existsSync(output)).toBe(false);
    expect(createManagedHandoffLeaseStore().read(root)).toMatchObject({
      kind: "current",
      lease: { owner: "replacement" },
    });
    expect(createManagedHandoffLeaseStore().read(candidateRoot)).toEqual({ kind: "absent" });
  });

  it.each([false, true])(
    "rejects a changed parent grant and settles its child (changed root=%s)",
    async (changedRoot) => {
      const candidateRoot = changedRoot ? path.join(root, "activated") : root;
      if (changedRoot) {
        fs.mkdirSync(candidateRoot);
      }
      const output = path.join(root, "effect");
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        const result = await withUpdateCommandExecutorChild(
          fence,
          candidateRoot,
          (grant, beforeInput) =>
            runUtf8CommandWithTimeout(
              [
                process.execPath,
                "--import",
                path.resolve("scripts/tsx.mjs"),
                "--input-type=module",
                "-e",
                program,
              ],
              {
                input: JSON.stringify({
                  grant: {
                    ...grant,
                    parent: { ...grant.parent, updatedAt: grant.parent.updatedAt + 1 },
                  },
                  output,
                  root: candidateRoot,
                }),
                beforeInput,
                timeoutMs: 15_000,
                killProcessTree: true,
              },
            ),
        );
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("does not match its parent");
        expect(fs.existsSync(output)).toBe(false);
        fence.assertCurrent();
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains a candidate group after both the updater and its direct child exit",
    async () => {
      const { runtimeEntry, options } = prepareStagedLeaseFixture();
      const command = `
        const {spawn}=require('node:child_process');
        process.stdin.once('data',()=>{
          const leaf=spawn(process.execPath,['-e',"setInterval(()=>{},1000);process.send('ready')"],{stdio:['ignore','ignore','ignore','ipc']});
          leaf.once('message',()=>{process.stdout.write(String(leaf.pid));leaf.disconnect();leaf.unref();});
        });
      `;
      const parent = spawnSync(
        process.execPath,
        [
          "-e",
          `
        const {spawn}=require('node:child_process');
        const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
        const store=createManagedHandoffLeaseStore(${JSON.stringify(options)});
        const original=store.acquire(${JSON.stringify(root)},'parent',{kind:'update'});
        const delegation=store.acquire(${JSON.stringify(root + "/.openclaw-update-child-group")},'run',{kind:'update'});
        if(original.kind!=='acquired'||delegation.kind!=='acquired')throw new Error('admission failed');
        const child=spawn(process.execPath,['-e',${JSON.stringify(command)}],{detached:true,stdio:['pipe','pipe','inherit']});
        if(!store.bind(delegation.lease,child.pid))throw new Error('bind failed');
        child.stdout.pipe(process.stdout);child.stdin.end('start');
      `,
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(parent.status, parent.stderr).toBe(0);
      const descendant = Number(parent.stdout);
      expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
      const store = createManagedHandoffLeaseStore();
      try {
        expect(store.acquire(root, "new", { kind: "update" }).kind).toBe("busy");
      } finally {
        process.kill(descendant, "SIGTERM");
        const candidate = store.read(root + "/.openclaw-update-child-group");
        assert(candidate.kind === "current", "Candidate group lease is missing");
        // A Linux zombie has exited but retains its process group until reaped.
        await vi.waitFor(
          () => expect(isChildProcessTreeAlive(candidate.lease.executor)).toBe(false),
          { timeout: 2_000, interval: 25 },
        );
      }
      const next = store.acquire(root, "new", { kind: "update" });
      expect(next.kind).toBe("acquired");
      if (next.kind === "acquired") {
        expect(store.release(next.lease)).toBe(true);
      }
    },
  );

  it("does not reclaim a dead parent while its delegated child is alive", async () => {
    const { runtimeEntry, options } = prepareStagedLeaseFixture();
    const parent = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const {spawn}=require("node:child_process");
      const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
      const store=createManagedHandoffLeaseStore(${JSON.stringify(options)});
      const parent=store.acquire(${JSON.stringify(root)},"parent",{kind:"update"});
      const delegated=store.acquire(${JSON.stringify(root + "/.openclaw-update-child-test")},"run",{kind:"update"});
      if(parent.kind!=="acquired"||delegated.kind!=="acquired")throw new Error("admission failed");
      const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});
      child.unref();
      if(!store.bind(delegated.lease,child.pid))throw new Error("bind failed");
      process.stdout.write(String(child.pid));
    `,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(parent.status, parent.stderr).toBe(0);
    const pid = Number(parent.stdout);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    const existingAuthority = {
      ...captureManagedUpdateLeaseDatabaseIdentity(options.databasePath),
      installKey: root,
    };
    const recover = () =>
      withUpdateCommandExecutor(
        randomUUID(),
        async (executor) => {
          const fence = await executor.enter(root);
          fence.assertCurrent();
          const recovered = createManagedHandoffLeaseStore().read(root);
          assert(recovered.kind === "current", "Recovery executor was not acquired");
          expect(recovered.lease.owner).not.toBe("parent");
        },
        { existingAuthority },
      );
    try {
      expect(createManagedHandoffLeaseStore().acquire(root, "new", { kind: "update" }).kind).toBe(
        "busy",
      );
      await expect(recover()).rejects.toThrow("Another update executor");
    } finally {
      process.kill(pid, "SIGTERM");
      await vi.waitFor(() => expect(isChildProcessTreeAlive({ pid })).toBe(false), {
        timeout: 2_000,
        interval: 25,
      });
    }
    await recover();
    const store = createManagedHandoffLeaseStore();
    const acquired = store.acquire(root, "new", { kind: "update" });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind === "acquired") {
      expect(store.release(acquired.lease)).toBe(true);
    }
  });
});
