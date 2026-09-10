import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createApplicationOverlays } from "../../../ui/src/app/overlays.ts";
import { bindUpdateConfigWriteInterlock } from "../../../ui/src/app/update-config-interlock.ts";
import { updateRunHarness } from "../../../ui/src/app/update-run.test-support.ts";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "../../infra/package-update-activation-journal.js";
import { assertNoPendingPackageActivation } from "../../infra/package-update-activation.js";
import { activationDriverCustodyArgs } from "../../infra/package-update-activation.process.test-support.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "../../infra/update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "../../infra/update-managed-service-handoff-runtime.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  getUpdateRun,
  reconcileAbandonedUpdateRuns,
} from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import { isChildProcessTreeAlive } from "../../process/child-process-tree.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { waitForPidToExit } from "../../test-utils/process-tree.js";
import {
  captureUpdateCommandExecutorAuthority,
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

let unjoinedProcess = false;
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    if (!unjoinedProcess) {
      cleanup();
    }
  }),
);
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
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function replaceOwner() {
  const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
  try {
    db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
      "replacement",
      root,
    );
  } finally {
    db.close();
  }
}

describe("live update executor", () => {
  it.each([
    undefined,
    null,
    {},
    { host: "", pid: 1, startIdentity: "0" },
    { host: "local", pid: 0, startIdentity: "0" },
    { host: "local", pid: 1, startIdentity: "unknown" },
  ])("rejects a malformed explicit driver without self-adopting (%j)", (driver) => {
    const options = { env: { OPENCLAW_STATE_DIR: path.join(root, "state") } };
    const run = createUpdateRun({ trigger: "cli" }, options);
    expect(() =>
      Reflect.apply(adoptUpdateRun, undefined, [run.runId, { ...options, driver }]),
    ).toThrow();
    expect(getUpdateRun(run.runId, options)).toEqual(run);
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
    stageManagedHandoffRuntime(root);
    const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
    const options = {
      databasePath: path.join(temporary, "managed-update-handoffs.sqlite"),
      serviceManagerEnv: resolveServiceManagerEnv(),
    };
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
    stageManagedHandoffRuntime(root);
    const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
    const runId = randomUUID();
    const owner = randomUUID();
    const metadata = path.join(root, "handoff.json");
    fs.writeFileSync(
      metadata,
      JSON.stringify({ version: 1, meta: { runId, handoffId: owner, root } }),
    );
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
    vi.stubEnv(CONTROL_PLANE_UPDATE_SENTINEL_META_ENV, metadata);
    const options = {
      databasePath: path.join(temporary, "managed-update-handoffs.sqlite"),
      serviceManagerEnv: resolveServiceManagerEnv(),
    };
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
    fs.writeFileSync(database, "unreadable native owner");
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

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "post-core driver custody",
  () => {
    it.each(["before-grant", "after-grant", "refused"] as const)(
      "records bound custody before fd3 delivery (%s)",
      async (mode) => {
        const packages = await createPackageSwapFixture(root);
        const state = path.join(root, "state");
        const runId = randomUUID();
        const receipt = path.join(root, "receiver.json");
        const observation = path.join(root, "delivery.json");
        const completed = path.join(root, "completed.json");
        const spawned = path.join(root, "spawned.json");
        const databasePath = path.join(temporary, "managed-update-handoffs.sqlite");
        const options = { env: { OPENCLAW_STATE_DIR: state } };
        for (const directory of [state, path.join(root, "home")]) {
          fs.mkdirSync(directory);
        }
        createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
        const authority = {
          ...captureManagedUpdateLeaseDatabaseIdentity(databasePath),
          installKey: packages.packageRoot,
        };
        const parent = spawn(
          process.execPath,
          activationDriverCustodyArgs({ base: root, mode, runId, packages, authority }),
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              HOME: path.join(root, "home"),
              TMPDIR: temporary,
              LC_ALL: "C",
              TZ: "UTC",
              OPENCLAW_STATE_DIR: state,
              OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
              OPENCLAW_NO_RESPAWN: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let diagnostics = "";
        parent.stdout.on("data", (chunk: Buffer) => {
          diagnostics += chunk.toString();
        });
        parent.stderr.on("data", (chunk: Buffer) => {
          diagnostics += chunk.toString();
        });
        const closed = once(parent, "close");
        let childPid: number | undefined;
        let childStart: string | undefined;
        let overlays: ReturnType<typeof createApplicationOverlays> | undefined;
        let stopInterlock: (() => void) | undefined;
        const stopCandidate = async () => {
          if (!childPid) {
            return;
          }
          if (isChildProcessTreeAlive({ pid: childPid })) {
            if (!isPidDefinitelyDead(childPid)) {
              expect(String(getFileLockProcessStartTime(childPid))).toBe(childStart);
            }
            try {
              process.kill(-childPid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                throw error;
              }
            }
          }
          await vi.waitFor(() => expect(isChildProcessTreeAlive({ pid: childPid })).toBe(false), {
            timeout: 5_000,
            interval: 25,
          });
        };
        const verifyCustody = async () => {
          await vi.waitFor(
            () => {
              const ready =
                mode === "refused" ? completed : mode === "before-grant" ? observation : receipt;
              expect(fs.existsSync(ready), diagnostics).toBe(true);
            },
            { timeout: 25_000, interval: 25 },
          );
          if (mode === "refused") {
            await closed;
            const result = JSON.parse(fs.readFileSync(completed, "utf8"));
            childPid = result.pid;
            expect(result.error).toContain("cannot be adopted");
            expect(result.bytesWritten).toBe(0);
            expect(fs.existsSync(observation)).toBe(false);
            expect(fs.existsSync(receipt)).toBe(false);
            expect(Number.isSafeInteger(childPid)).toBe(true);
            expect(isChildProcessTreeAlive({ pid: childPid! })).toBe(false);
            expect(getUpdateRun(runId, options)?.reason).toBe("fixture-terminal");
            return;
          }
          const observed = JSON.parse(fs.readFileSync(observation, "utf8"));
          childPid = observed.bound.pid;
          childStart = observed.bound.startIdentity;
          expect(observed.bytesWritten).toBe(0);
          expect(observed.run.origin.driver).toEqual({
            host: observed.parent.host,
            ...observed.bound,
          });
          expect(observed.run.origin.previousDrivers).toContainEqual(observed.parent);
          expect(observed.renewed.updatedAtMs).toBeGreaterThan(observed.run.updatedAtMs);
          expect(observed.renewed.origin).toEqual(observed.run.origin);
          if (mode === "after-grant") {
            expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toMatchObject({
              pid: childPid,
              run: { runId, origin: observed.run.origin },
            });
            parent.kill("SIGKILL");
          } else {
            expect(fs.existsSync(receipt)).toBe(false);
          }
          await closed;
          expect(isPidDefinitelyDead(parent.pid!)).toBe(true);
          expect(isPidDefinitelyDead(childPid!)).toBe(false);
          vi.spyOn(Date, "now").mockReturnValue(
            observed.renewed.updatedAtMs + ABANDONED_UPDATE_RUN_MS + 10,
          );
          expect(reconcileAbandonedUpdateRuns({}, options)).toEqual([]);
          expect(getUpdateRun(runId, options)?.status).toBe("running");
          let suspended = false;
          overlays = createApplicationOverlays(
            updateRunHarness(async (method) => {
              reconcileAbandonedUpdateRuns({}, options);
              const run = getUpdateRun(runId, options);
              return method === "update.runs.get"
                ? { run }
                : {
                    lastRun: run,
                    ...(run?.status === "running" ? { activeRun: run } : {}),
                  };
            }).gateway,
          );
          stopInterlock = bindUpdateConfigWriteInterlock(overlays, {
            setWritesSuspended(value) {
              suspended = value;
            },
          });
          await overlays.refreshUpdateStatus();
          expect(overlays.snapshot.updateRunning).toBe(true);
          expect(overlays.snapshot.updateReconciliationPending).toBe(true);
          expect(suspended).toBe(true);
          await expect(
            withUpdateCommandExecutor(
              randomUUID(),
              async (executor) => executor.enter(packages.packageRoot),
              { existingAuthority: authority },
            ),
          ).rejects.toThrow("Another update executor");
          const journal = openPackageActivationJournal(
            resolvePackageActivationAnchor(packages.packageRoot),
          );
          const retained = journal.read();
          expect(retained.phase).toBe("publication-complete");
          expect(() => assertNoPendingPackageActivation(packages.packageRoot)).toThrow(
            "recovery is pending",
          );
          await stopCandidate();
          expect(reconcileAbandonedUpdateRuns({}, options)).toMatchObject([
            { runId, status: "failed", reason: "abandoned" },
          ]);
          await overlays.refreshUpdateStatus();
          expect(suspended).toBe(false);
          expect(journal.read()).toEqual(retained);
          expect(() => assertNoPendingPackageActivation(packages.packageRoot)).toThrow(
            "recovery is pending",
          );
        };
        const failures: unknown[] = [];
        // A body failure must not skip either process join, and a cleanup
        // failure must retain the fixture without hiding the original error.
        for (const phase of [
          verifyCustody,
          async () => {
            stopInterlock?.();
            overlays?.dispose();
          },
          async () => {
            if (fs.existsSync(spawned)) {
              const identity = JSON.parse(fs.readFileSync(spawned, "utf8"));
              childPid ??= identity.pid;
              childStart ??= String(identity.startIdentity);
            }
            await stopCandidate();
          },
          async () => {
            if (parent.exitCode === null && parent.signalCode === null) {
              parent.kill("SIGKILL");
            }
            await closed;
          },
        ]) {
          try {
            await phase();
          } catch (error) {
            if (phase !== verifyCustody) {
              unjoinedProcess = true;
            }
            failures.push(error);
          }
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "Driver custody proof and cleanup failed");
        }
      },
      40_000,
    );
  },
);

describe("candidate executor delegation", () => {
  const moduleUrl = new URL("./update-command-executor.ts", import.meta.url).href;
  const program = `
    import fs from "node:fs";
    import {spawn} from "node:child_process";
    import {once} from "node:events";
    import {setTimeout} from "node:timers/promises";
    import {withDelegatedUpdateCommandExecutor} from ${JSON.stringify(moduleUrl)};
    const input=JSON.parse(fs.readFileSync(0,"utf8"));
    await withDelegatedUpdateCommandExecutor(input.grant,input.grant.runId,input.grant.root,async (fence)=>{
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
  it.each([false, true])(
    "retains parent exclusion through a real child (revoked=%s)",
    async (revoked) => {
      const ready = createDeferred();
      const proceed = path.join(root, "proceed");
      const output = path.join(root, "effect");
      const work = withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        const pending = withUpdateCommandExecutorChild(fence, (grant, bindChild) =>
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
              input: JSON.stringify({ grant, proceed, output }),
              beforeInput(pid) {
                bindChild(pid, (identity) => {
                  const child = createManagedHandoffLeaseStore().read(grant.childKey);
                  assert(child.kind === "current", "Child binding was not committed");
                  expect(identity).toEqual(child.lease.executor);
                  expect(Object.isFrozen(identity)).toBe(true);
                  expect(() => Object.assign(identity, { pid: process.pid })).toThrow();
                });
              },
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
              throw new Error(result.stderr);
            }),
          ]);
          expect(() => fence.assertCurrent()).toThrow("suspended");
          const store = createManagedHandoffLeaseStore();
          const primary = store.read(root);
          expect(primary.kind).toBe("current");
          if (primary.kind !== "current") {
            throw new Error("missing primary owner");
          }
          expect(store.release(primary.lease)).toBe(false);
          expect(store.bind(primary.lease, process.pid)).toBeNull();
          if (revoked) {
            replaceOwner();
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
        expect(fs.existsSync(output)).toBe(false);
      } else {
        await work;
        expect(fs.readFileSync(output, "utf8")).toBe("owned");
        expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not release installation ownership while a candidate descendant is alive",
    async () => {
      let descendant: number | undefined;
      try {
        await expect(
          withUpdateCommandExecutor(randomUUID(), async (executor) => {
            const fence = await executor.enter(root);
            await withUpdateCommandExecutorChild(fence, async (grant, beforeInput) => {
              const result = await runUtf8CommandWithTimeout(
                [
                  process.execPath,
                  "-e",
                  `const fs=require('node:fs');const {spawn}=require('node:child_process');
                  JSON.parse(fs.readFileSync(0,'utf8'));
                  const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000);process.send('ready')"],{stdio:['ignore','ignore','ignore','ipc']});
                  child.once('message',()=>{process.stdout.write(String(child.pid));child.disconnect();child.unref();});`,
                ],
                {
                  input: JSON.stringify(grant),
                  beforeInput,
                  killProcessTree: true,
                  timeoutMs: 15_000,
                },
              );
              descendant = Number(result.stdout);
              expect(result.code, result.stderr).toBe(0);
              expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
              process.kill(descendant, 0);
              return result;
            });
          }),
        ).rejects.toThrow(/settled|release/);
        const store = createManagedHandoffLeaseStore();
        expect(store.acquire(root, "next-owner", { kind: "update" }).kind).toBe("busy");
      } finally {
        if (descendant) {
          process.kill(descendant, "SIGTERM");
          await waitForPidToExit(descendant);
        }
      }
    },
  );

  it("rejects a grant that does not match the stored parent generation", async () => {
    const output = path.join(root, "effect");
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      const result = await withUpdateCommandExecutorChild(fence, (grant, beforeInput) =>
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
  });

  it.skipIf(process.platform === "win32")(
    "retains a candidate group after both the updater and its direct child exit",
    async () => {
      stageManagedHandoffRuntime(root);
      const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
      const options = {
        databasePath: path.join(temporary, "managed-update-handoffs.sqlite"),
        serviceManagerEnv: resolveServiceManagerEnv(),
      };
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
    stageManagedHandoffRuntime(root);
    const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
    const options = {
      databasePath: path.join(temporary, "managed-update-handoffs.sqlite"),
      serviceManagerEnv: resolveServiceManagerEnv(),
    };
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
