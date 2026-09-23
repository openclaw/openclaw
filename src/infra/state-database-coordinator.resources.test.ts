import { fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "./state-database-coordinator.js";
import {
  createCoordinatorResourceTestHarness,
  resolveCoordinatorModuleUrl,
  runCoordinatorSource,
  withResourceContextPreload,
} from "./state-database-coordinator.resources.test-support.js";

const { tempDirs, createStandaloneOwner } = createCoordinatorResourceTestHarness();
const testNodeExecPath = resolveTestNodeExecPath();
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const resourceContextPreload = pathToFileURL(
  path.join(repositoryRoot, "src/infra/vitest-resource-context-preload.test-support.mjs"),
).href;

describe("state database coordinator", () => {
  it("reads complete owner and release receipts across short native reads", () => {
    const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-short-reads-");
    const result = runCoordinatorSource(
      `
      import fs from "node:fs";
      import path from "node:path";
      const { acquireStateDatabaseCoordinator } = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
      const { findVitestResourceOwner } = await import(${JSON.stringify(
        pathToFileURL(path.join(import.meta.dirname, "vitest-resource-ownership.ts")).href,
      )});
      const root = ${JSON.stringify(ownedRoot)};
      const original = fs.readSync;
      let shortReads = 0;
      fs.readSync = function(fd, buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
        const bytes = original.call(this, fd, buffer, offset, Math.min(length, 16), position);
        if (bytes > 0 && bytes < length) shortReads++;
        return bytes;
      };
      let pendingRefused = false;
      let corruptionRefused = false;
      try {
        const owner = findVitestResourceOwner(root);
        const coordinator = acquireStateDatabaseCoordinator({ databasePath: path.join(root, "state.sqlite") });
        try {
          try { owner.assertReleased(); } catch { pendingRefused = true; }
        } finally { coordinator.release(); }
        owner.assertReleased();
        const claims = path.join(root, ".vitest-resource-owner", "claims");
        const receipt = path.join(claims, fs.readdirSync(claims)[0], "released");
        const valid = fs.readFileSync(receipt);
        try {
          fs.writeFileSync(receipt, "not a valid completion receipt");
          try { owner.assertReleased(); } catch { corruptionRefused = true; }
        } finally { fs.writeFileSync(receipt, valid); }
        owner.assertReleased();
      } finally { fs.readSync = original; }
      console.log(JSON.stringify({ pendingRefused, corruptionRefused, shortReads }));
      `,
      {
        VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
        VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
          { root: ownedRoot, identity: owner.identity },
        ]),
      },
    );
    expect(result).toMatchObject({ pendingRefused: true, corruptionRefused: true });
    expect(result.shortReads).toBeGreaterThan(1);
    expect(() => owner.assertReleased()).not.toThrow();
  });

  it("routes isolated databases through the owned root and releases its claim", () => {
    const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-claim-");
    const databasePath = path.join(ownedRoot, "state", "openclaw.sqlite");
    const result = runCoordinatorSource(
      `
        import fs from "node:fs";
        import path from "node:path";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const coordinator = coordinatorModule.acquireStateDatabaseCoordinator({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 0 });
        const claims = path.join(${JSON.stringify(ownedRoot)}, ".vitest-resource-owner", "claims");
        const claim = path.join(claims, fs.readdirSync(claims)[0]);
        const pendingWhileHeld = !fs.existsSync(path.join(claim, "released"));
        coordinator.release();
        console.log(JSON.stringify({ path: coordinator.path, pendingWhileHeld, released: fs.existsSync(path.join(claim, "released")), runtimeDirectory: coordinatorModule.resolveStateLifecycleRuntimeDirectory(${JSON.stringify(databasePath)}) }));
      `,
      {
        VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
        VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
          { root: ownedRoot, identity: owner.identity },
        ]),
      },
    );

    expect(result).toMatchObject({
      pendingWhileHeld: true,
      released: true,
      runtimeDirectory: ownedRoot,
    });
    expect((result.path as string).startsWith(`${ownedRoot}${path.sep}`)).toBe(true);
    expect(() => owner.assertReleased()).not.toThrow();
  });

  it.each(["shared handle", "legacy cleanup", "device identity"])(
    "keeps %s coordination under its owner until release",
    (kind) => {
      const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-entry-");
      const databasePath = path.join(ownedRoot, "state", "openclaw.sqlite");
      const deviceModule = pathToFileURL(
        path.join(import.meta.dirname, "device-identity-coordinator.ts"),
      ).href;
      const result = runCoordinatorSource(
        `
        import fs from "node:fs";
        import path from "node:path";
        const module = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const databasePath = ${JSON.stringify(databasePath)};
        const kind = ${JSON.stringify(kind)};
        const params = { databasePath, busyTimeoutMs: 0 };
        const coordinator = kind === "shared handle"
          ? module.acquireStateDatabaseHandleLease(params)
          : kind === "legacy cleanup"
            ? module.tryAcquireGatewayLifecycleCleanupCoordinator(params)
            : (await import(${JSON.stringify(deviceModule)})).acquireDeviceIdentityCoordinator({
                ...params, stateDir: ${JSON.stringify(ownedRoot)},
              });
        if (!coordinator) throw new Error("fixture unexpectedly contended");
        const claims = path.join(${JSON.stringify(ownedRoot)}, ".vitest-resource-owner", "claims");
        const receipts = () => fs.readdirSync(claims).map(id => fs.existsSync(path.join(claims, id, "released")));
        const held = receipts();
        const lockRoot = path.join(${JSON.stringify(ownedRoot)}, process.getuid ? "openclaw-state-locks-" + process.getuid() : "openclaw-state-locks");
        const locks = fs.readdirSync(lockRoot);
        coordinator.release();
        console.log(JSON.stringify({ held, released: receipts(), locks }));
      `,
        {
          VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
          VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
            { root: ownedRoot, identity: owner.identity },
          ]),
        },
      );
      expect(result.held).toEqual([false]);
      expect(result.released).toEqual([true]);
      const family =
        kind === "shared handle"
          ? "state-handles"
          : kind === "legacy cleanup"
            ? "gateway-lifecycle"
            : "state-lifecycle";
      expect(result.locks).toEqual([
        expect.stringMatching(new RegExp(`^${family}\\.[a-f0-9]{8}\\.lock\\.sqlite$`)),
      ]);
      expect(() => owner.assertReleased()).not.toThrow();
    },
  );

  it("claims both the database owner and a distinct explicit coordinator owner", () => {
    const databaseResource = createStandaloneOwner("openclaw-coordinator-database-owner-");
    const coordinatorResource = createStandaloneOwner("openclaw-coordinator-path-owner-");
    const databasePath = path.join(databaseResource.ownedRoot, "state", "openclaw.sqlite");
    const coordinatorPath = path.join(
      coordinatorResource.ownedRoot,
      "custom-locks",
      "gateway.lock.sqlite",
    );
    const result = runCoordinatorSource(
      `
        import fs from "node:fs";
        import path from "node:path";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const claimState = (root) => {
          const claims = path.join(root, ".vitest-resource-owner", "claims");
          return fs.readdirSync(claims).map((claim) => fs.existsSync(path.join(claims, claim, "released")));
        };
        const coordinator = coordinatorModule.acquireGatewayLifecycleCoordinator({
          databasePath: ${JSON.stringify(databasePath)},
          coordinatorPath: ${JSON.stringify(coordinatorPath)},
          busyTimeoutMs: 0,
        });
        const held = {
          database: claimState(${JSON.stringify(databaseResource.ownedRoot)}),
          coordinator: claimState(${JSON.stringify(coordinatorResource.ownedRoot)}),
        };
        coordinator.release();
        console.log(JSON.stringify({
          path: coordinator.path,
          held,
          released: {
            database: claimState(${JSON.stringify(databaseResource.ownedRoot)}),
            coordinator: claimState(${JSON.stringify(coordinatorResource.ownedRoot)}),
          },
        }));
      `,
      {
        VITEST_OPENCLAW_RESOURCE_ROOT: databaseResource.ownedRoot,
        VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
          {
            root: databaseResource.ownedRoot,
            identity: databaseResource.owner.identity,
          },
          {
            root: coordinatorResource.ownedRoot,
            identity: coordinatorResource.owner.identity,
          },
        ]),
      },
    );

    expect(result).toEqual({
      path: coordinatorPath,
      held: { database: [false], coordinator: [false] },
      released: { database: [true], coordinator: [true] },
    });
    expect(() => databaseResource.owner.assertReleased()).not.toThrow();
    expect(() => coordinatorResource.owner.assertReleased()).not.toThrow();
  });

  it("releases its claim when rollback reports failure after SQLite close succeeds", () => {
    const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-release-failure-");
    const databasePath = path.join(ownedRoot, "state", "openclaw.sqlite");
    const result = runCoordinatorSource(
      `
        import fs from "node:fs";
        import path from "node:path";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const { DatabaseSync } = await import("node:sqlite");
        const coordinator = coordinatorModule.acquireStateDatabaseCoordinator({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 0 });
        const nativeExec = DatabaseSync.prototype.exec;
        DatabaseSync.prototype.exec = function(sql) {
          if (sql === "ROLLBACK") throw new Error("simulated rollback failure");
          return nativeExec.call(this, sql);
        };
        let errorMessage;
        try { coordinator.release(); } catch (error) { errorMessage = error.message; }
        DatabaseSync.prototype.exec = nativeExec;
        const claims = path.join(${JSON.stringify(ownedRoot)}, ".vitest-resource-owner", "claims");
        const claim = path.join(claims, fs.readdirSync(claims)[0]);
        console.log(JSON.stringify({ errorMessage, released: fs.existsSync(path.join(claim, "released")) }));
      `,
      {
        VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
        VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
          { root: ownedRoot, identity: owner.identity },
        ]),
      },
    );

    expect(result).toEqual({
      errorMessage: expect.stringContaining("failed to release state-lifecycle coordinator"),
      released: true,
    });
    expect(() => owner.assertReleased()).not.toThrow();
  });

  it("retains its claim on failed SQLite close and settles after retry", () => {
    const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-close-failure-");
    const databasePath = path.join(ownedRoot, "state", "openclaw.sqlite");
    const result = runCoordinatorSource(
      `
        import fs from "node:fs";
        import path from "node:path";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const { DatabaseSync } = await import("node:sqlite");
        const coordinator = coordinatorModule.acquireStateDatabaseCoordinator({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 0 });
        const nativeClose = DatabaseSync.prototype.close;
        DatabaseSync.prototype.close = function() {
          throw new Error("simulated close failure");
        };
        let errorMessage;
        try { coordinator.release(); } catch (error) { errorMessage = error.message; }
        DatabaseSync.prototype.close = nativeClose;
        const claims = path.join(${JSON.stringify(ownedRoot)}, ".vitest-resource-owner", "claims");
        const claim = path.join(claims, fs.readdirSync(claims)[0]);
        const releasedAfterFailure = fs.existsSync(path.join(claim, "released"));
        const closedAfterFailure = coordinator.closed;
        coordinator.release();
        console.log(JSON.stringify({ errorMessage, releasedAfterFailure, closedAfterFailure, released: fs.existsSync(path.join(claim, "released")), closed: coordinator.closed }));
      `,
      {
        VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
        VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
          { root: ownedRoot, identity: owner.identity },
        ]),
      },
    );

    expect(result).toEqual({
      errorMessage: expect.stringContaining("failed to release state-lifecycle coordinator"),
      releasedAfterFailure: false,
      closedAfterFailure: false,
      released: true,
      closed: true,
    });
    expect(() => owner.assertReleased()).not.toThrow();
  });

  it.each(["open", "annotation", "exit", "heartbeat", "heartbeat-retry"])(
    "settles only a joined Worker's native claims (registry move: %s)",
    (registryMove) => {
      const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-crash-");
      const ownershipModule = pathToFileURL(
        path.join(import.meta.dirname, "vitest-resource-ownership.ts"),
      ).href;
      const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { register } = await import("tsx/esm/api");
        register();
        if (workerData.closeAdmission) {
          const fs = require("node:fs");
          const path = require("node:path");
          const mkdir = fs.mkdirSync;
          fs.mkdirSync = function(directory, ...args) {
            const result = mkdir.call(this, directory, ...args);
            if (path.dirname(String(directory)) === workerData.registry) {
              fs.renameSync(workerData.registry, workerData.registry + ".closed");
              fs.mkdirSync = mkdir;
            }
            return result;
          };
        }
        const { acquireStateDatabaseHandleLease } = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const held = acquireStateDatabaseHandleLease({ databasePath: workerData.path, busyTimeoutMs: 0 });
        const extra = workerData.retryPublication
          ? acquireStateDatabaseHandleLease({ databasePath: workerData.path + ".second", busyTimeoutMs: 0 })
          : undefined;
        parentPort.on("message", () => { extra?.release(); held.release(); parentPort.close(); });
        parentPort.postMessage("held");
      })();
    `;
      const result = runCoordinatorSource(
        `
        import fs from "node:fs";
        import path from "node:path";
        import { once } from "node:events";
        import { Worker } from "node:worker_threads";
        const { findVitestResourceOwner } = await import(${JSON.stringify(ownershipModule)});
        const owner = findVitestResourceOwner(${JSON.stringify(ownedRoot)});
        const admittedRegistry = path.join(${JSON.stringify(ownedRoot)}, ".vitest-resource-owner", "claims");
        const registry = () => fs.existsSync(admittedRegistry) ? admittedRegistry : admittedRegistry + ".closed";
        const generalRelease = owner.claim();
        const generalClaim = fs.readdirSync(registry())[0];
        const retained = () => { try { owner.assertReleased(); return false; } catch { return true; } };
        const workers = [];
        try {
          for (const name of ["crashed", "sibling"]) {
            const worker = new Worker(${JSON.stringify(workerSource)}, {
              eval: true, execArgv: ["--import", "tsx"],
              workerData: {
                path: path.join(${JSON.stringify(ownedRoot)}, name, "state.sqlite"),
                registry: admittedRegistry,
                retryPublication: name === "crashed" && ${JSON.stringify(registryMove)} === "heartbeat-retry",
                closeAdmission: name === "sibling" && ${JSON.stringify(registryMove)} === "annotation",
              },
            });
            workers.push(worker);
            await once(worker, "message");
          }
          const siblingOwner = process.pid + ":" + workers[1].threadId;
          const siblingClaim = fs.readdirSync(registry()).find(id => {
            const marker = path.join(registry(), id, "native-worker");
            return fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === siblingOwner;
          });
          const crashOwner = process.pid + ":" + workers[0].threadId;
          const crashClaim = fs.readdirSync(registry()).find(id => {
            const marker = path.join(registry(), id, "native-worker");
            return fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === crashOwner;
          });
          if (${JSON.stringify(registryMove)} === "exit") {
            const writeFile = fs.writeFileSync;
            fs.writeFileSync = function(file, ...args) {
              if (path.basename(String(file)) === "native-exited") {
                fs.renameSync(admittedRegistry, admittedRegistry + ".closed");
                fs.writeFileSync = writeFile;
              }
              return writeFile.call(this, file, ...args);
            };
          }
          const heartbeat = ${JSON.stringify(registryMove)}.startsWith("heartbeat")
            ? (await import(${JSON.stringify(pathToFileURL(path.join(repositoryRoot, "src/state/openclaw-state-lease-heartbeat-cleanup.ts")).href)})).createLeaseHeartbeatCleanup({
                cancel() {}, onReleaseFailed(error) { throw error; },
              })
            : undefined;
          heartbeat?.start(() => workers[0]);
          const crashJoin = heartbeat ? undefined : owner.joinNativeWorkerExit(workers[0]);
          const heldBeforeExit = Boolean(crashClaim) && retained() &&
            !fs.existsSync(path.join(registry(), crashClaim, "released")) &&
            !fs.existsSync(path.join(registry(), crashClaim, "native-exited"));
          let retryFailure;
          if (${JSON.stringify(registryMove)} === "heartbeat-retry") {
            const writeFile = fs.writeFileSync;
            let publications = 0;
            fs.writeFileSync = function(file, ...args) {
              if (path.basename(String(file)) === "native-exited" && ++publications === 2) {
                throw Object.assign(new Error("controlled native-exit publication failure"), { code: "EACCES" });
              }
              return writeFile.call(this, file, ...args);
            };
            let rejected = false;
            try {
              await heartbeat.stop();
            } catch (error) {
              rejected = error.cause?.code === "EACCES";
            } finally {
              fs.writeFileSync = writeFile;
            }
            const crashClaims = fs.readdirSync(registry()).filter(id => {
              const marker = path.join(registry(), id, "native-worker");
              return fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === crashOwner;
            });
            retryFailure = {
              rejected,
              pending: heartbeat.cleanup.pending,
              exited: workers[0].threadId === -1,
              published: crashClaims.filter(id => fs.existsSync(path.join(registry(), id, "native-exited"))).length,
              missing: crashClaims.filter(id => !fs.existsSync(path.join(registry(), id, "native-exited"))).length,
            };
          }
          if (heartbeat) {
            await heartbeat.stop();
            if (heartbeat.cleanup.pending) throw new Error("heartbeat cleanup retained native custody");
          } else {
            await Promise.all([workers[0].terminate(), crashJoin]);
          }
          const siblingRetained = Boolean(siblingClaim) && retained() &&
            !fs.existsSync(path.join(registry(), siblingClaim, "released")) &&
            !fs.existsSync(path.join(registry(), siblingClaim, "native-exited"));
          const exited = once(workers[1], "exit");
          workers[1].postMessage("close");
          await exited;
          const generalRetained = retained() &&
            !fs.existsSync(path.join(registry(), generalClaim, "released")) &&
            !fs.existsSync(path.join(registry(), generalClaim, "native-exited"));
          generalRelease();
          const released = !retained();
          const receipts = fs.readdirSync(registry()).map(id => ({
            closed: fs.existsSync(path.join(registry(), id, "released")),
            exited: fs.existsSync(path.join(registry(), id, "native-exited")),
          }));
          const nativeClaims = fs.readdirSync(registry()).filter(id => {
            const marker = path.join(registry(), id, "native-worker");
            return fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === crashOwner;
          });
          const nativeOnly = nativeClaims.length === (${JSON.stringify(registryMove)} === "heartbeat-retry" ? 2 : 1) &&
            nativeClaims.every(id => !fs.existsSync(path.join(registry(), id, "released")) &&
              fs.existsSync(path.join(registry(), id, "native-exited")));
          console.log(JSON.stringify({ heldBeforeExit, siblingRetained, generalRetained, released, nativeOnly, receipts, ...(retryFailure ? { retryFailure } : {}) }));
        } finally {
          await Promise.all(workers.map(worker => worker.terminate()));
        }
      `,
        {
          VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
          VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
            { root: ownedRoot, identity: owner.identity },
          ]),
        },
      );
      expect(result).toEqual({
        heldBeforeExit: true,
        siblingRetained: true,
        generalRetained: true,
        released: true,
        nativeOnly: true,
        receipts: expect.arrayContaining([
          { closed: false, exited: true },
          { closed: true, exited: false },
        ]),
        ...(registryMove === "heartbeat-retry"
          ? {
              retryFailure: {
                rejected: true,
                pending: true,
                exited: true,
                published: 1,
                missing: 1,
              },
            }
          : {}),
      });
      expect(result.receipts).toHaveLength(registryMove === "heartbeat-retry" ? 4 : 3);
      expect(() => owner.assertReleased()).not.toThrow();
    },
  );

  it.each(
    ["open", "closed", "retry"].flatMap((mode) =>
      [false, true].map((workerThreads) => ({ mode, workerThreads })),
    ),
  )(
    "settles only a joined child process's native claims (registry: $mode, threads: $workerThreads)",
    ({ mode, workerThreads }) => {
      const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-process-exit-");
      const ownershipModule = pathToFileURL(
        path.join(import.meta.dirname, "vitest-resource-ownership.ts"),
      ).href;
      const workerSource = `
        const { parentPort, workerData } = require("node:worker_threads");
        (async () => {
          const { register } = await import("tsx/esm/api");
          register();
          const { acquireStateDatabaseHandleLease } = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
          const held = acquireStateDatabaseHandleLease({ databasePath: workerData, busyTimeoutMs: 0 });
          parentPort.once("message", () => { held.release(); parentPort.close(); });
          parentPort.postMessage("held");
        })();
      `;
      const childSource = `
        import { once } from "node:events";
        import { Worker } from "node:worker_threads";
        import { acquireStateDatabaseHandleLease } from ${JSON.stringify(resolveCoordinatorModuleUrl())};
        const held = [process.argv[1], process.argv[1] + ".second"].map(databasePath =>
          acquireStateDatabaseHandleLease({ databasePath, busyTimeoutMs: 0 }));
        const worker = ${workerThreads} ? new Worker(${JSON.stringify(workerSource)}, {
          eval: true, execArgv: ["--import", "tsx"], workerData: process.argv[1] + ".worker",
        }) : undefined;
        if (worker) await once(worker, "message");
        process.once("message", async () => {
          if (worker) {
            const exited = once(worker, "exit");
            worker.postMessage("release");
            await exited;
          }
          held.forEach(lease => lease.release());
          process.disconnect();
        });
        process.send("held");
      `;
      const result = runCoordinatorSource(
        `
        import fs from "node:fs";
        import path from "node:path";
        import { spawn } from "node:child_process";
        import { once } from "node:events";
        const { findVitestResourceOwner } = await import(${JSON.stringify(ownershipModule)});
        const root = ${JSON.stringify(ownedRoot)};
        const owner = findVitestResourceOwner(root);
        const admitted = path.join(root, ".vitest-resource-owner", "claims");
        const registry = () => fs.existsSync(admitted) ? admitted : admitted + ".closed";
        const generalRelease = owner.claim();
        const generalClaim = fs.readdirSync(registry())[0];
        const children = [];
        const settlements = [];
        const nativeWrite = fs.writeFileSync;
        try {
          for (const name of ["crashed", "sibling"]) {
            const child = spawn(process.execPath,
              ["--import", "tsx", "--input-type=module", "--eval", ${JSON.stringify(childSource)}, path.join(root, name + ".sqlite")],
              { stdio: ["ignore", "ignore", "pipe", "ipc"] });
            children.push(child);
            settlements.push(owner.observeNativeProcessExit(child, { includeWorkerThreads: ${workerThreads} }));
            await once(child, "message", { signal: AbortSignal.timeout(5000) });
          }
          const nativeClaims = child => fs.readdirSync(registry()).filter(id => {
            const file = path.join(registry(), id, "native-worker");
            return fs.existsSync(file) && fs.readFileSync(file, "utf8").startsWith(child.pid + ":");
          });
          const crashed = nativeClaims(children[0]);
          const siblings = nativeClaims(children[1]);
          const has = (id, name) => fs.existsSync(path.join(registry(), id, name));
          const pendingBeforeExit = crashed.every(id => !has(id, "released") && !has(id, "native-exited"));
          if (${JSON.stringify(mode)} === "closed") fs.renameSync(admitted, admitted + ".closed");
          const refused = new Error("process exit receipt refused");
          let publications = 0;
          if (${JSON.stringify(mode)} === "retry") {
            fs.writeFileSync = function(file, ...args) {
              if (path.basename(String(file)) === "native-exited" && ++publications === 2) throw refused;
              return nativeWrite.call(this, file, ...args);
            };
          }
          children[0].kill("SIGKILL");
          let retryFailure;
          try { await settlements[0](); }
          catch (error) {
            retryFailure = error.cause === refused && crashed.filter(id => has(id, "native-exited")).length === 1;
          } finally { fs.writeFileSync = nativeWrite; }
          await settlements[0]();
          let lateRefused = false;
          try { owner.observeNativeProcessExit(children[0]); } catch { lateRefused = true; }
          const siblingPending = siblings.every(id => !has(id, "released") && !has(id, "native-exited"));
          const mainClaims = crashed.filter(id => fs.readFileSync(path.join(registry(), id, "native-worker"), "utf8") === children[0].pid + ":0");
          const threadClaims = crashed.filter(id => !mainClaims.includes(id));
          const nativeOnly = mainClaims.length === 2 && threadClaims.length === (${workerThreads} ? 1 : 0) &&
            crashed.every(id => !has(id, "released") && has(id, "native-exited"));
          children[1].send("release");
          await settlements[1]();
          const generalPending = !has(generalClaim, "released") && !has(generalClaim, "native-exited");
          let retained = false;
          try { owner.assertReleased(); } catch { retained = true; }
          generalRelease();
          owner.assertReleased();
          console.log(JSON.stringify({ pendingBeforeExit, siblingPending, nativeOnly, generalPending, retained, lateRefused, ...(retryFailure === undefined ? {} : { retryFailure }) }));
        } finally {
          fs.writeFileSync = nativeWrite;
          for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }
          await Promise.all(settlements.map(settle => settle()));
        }
        `,
        {
          VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
          VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
            { root: ownedRoot, identity: owner.identity },
          ]),
        },
      );
      expect(result).toEqual({
        pendingBeforeExit: true,
        siblingPending: true,
        nativeOnly: true,
        generalPending: true,
        retained: true,
        lateRefused: true,
        ...(mode === "retry" ? { retryFailure: true } : {}),
      });
      expect(() => owner.assertReleased()).not.toThrow();
    },
  );

  it("fails closed without recreating an owner removed after import", () => {
    const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-removed-owner-");
    const databasePath = path.join(ownedRoot, "state", "openclaw.sqlite");
    const result = runCoordinatorSource(
      `
        import fs from "node:fs";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        fs.rmSync(${JSON.stringify(ownedRoot)}, { recursive: true });
        let errorCode;
        try {
          coordinatorModule.acquireStateDatabaseCoordinator({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 0 });
        } catch (error) {
          errorCode = error.code;
        }
        console.log(JSON.stringify({ errorCode, recreated: fs.existsSync(${JSON.stringify(ownedRoot)}) }));
      `,
      {
        VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
        VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
          { root: ownedRoot, identity: owner.identity },
        ]),
      },
    );

    expect(result).toEqual({ errorCode: "ENOENT", recreated: false });
  });

  it("uses the launcher's stable production lock root", () => {
    expect(process.env.VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT).toBeTruthy();
    expect(resolveStateLifecycleRuntimeDirectory()).toBe(
      process.env.VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT,
    );
  });

  it("rejects a resource root without an identity-bearing chain", () => {
    const { ownedRoot } = createStandaloneOwner("openclaw-coordinator-missing-chain-");
    const source = `
      let errorMessage;
      try {
        await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
      } catch (error) {
        errorMessage = error.message;
      }
      console.log(JSON.stringify({ errorMessage }));
    `;
    const env = withResourceContextPreload({
      ...process.env,
      VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
    });
    delete env.VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN;
    const child = spawnSync(
      testNodeExecPath,
      ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env,
        encoding: "utf8",
      },
    );

    expect(child.stdout).toBe("");
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(
      "Inherited Vitest resource root requires an identity-bearing chain",
    );
  });

  it("rejects an identity-bearing chain without its resource root", () => {
    const { ownedRoot, owner } = createStandaloneOwner(
      "openclaw-coordinator-missing-resource-root-",
    );
    const source = `
      let errorMessage;
      try {
        await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
      } catch (error) {
        errorMessage = error.message;
      }
      console.log(JSON.stringify({ errorMessage }));
    `;
    const env = withResourceContextPreload({
      ...process.env,
      VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
        { root: ownedRoot, identity: owner.identity },
      ]),
    });
    delete env.VITEST_OPENCLAW_RESOURCE_ROOT;
    const child = spawnSync(
      testNodeExecPath,
      ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env,
        encoding: "utf8",
      },
    );

    expect(child.stdout).toBe("");
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("Inherited Vitest resource root chain requires its root marker");
  });

  it("rejects a validated resource lineage without a production lock root", () => {
    const { ownedRoot, owner } = createStandaloneOwner(
      "openclaw-coordinator-missing-production-root-",
    );
    const source = `
      let errorMessage;
      try {
        await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
      } catch (error) {
        errorMessage = error.message;
      }
      console.log(JSON.stringify({ errorMessage }));
    `;
    const env = withResourceContextPreload({
      ...process.env,
      VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
      VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
        { root: ownedRoot, identity: owner.identity },
      ]),
    });
    delete env.VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT;
    const child = spawnSync(
      testNodeExecPath,
      ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env,
        encoding: "utf8",
      },
    );

    expect(child.stdout).toBe("");
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(
      "Inherited Vitest resource lineage requires a production lock root",
    );
  });

  it("rejects stale resource lineage in the process preload", () => {
    const root = tempDirs.make("openclaw-coordinator-stale-preload-");
    const staleRoot = path.join(root, "missing-owner");
    const env = withResourceContextPreload({
      ...process.env,
      VITEST_OPENCLAW_RESOURCE_ROOT: staleRoot,
      VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
        { root: staleRoot, identity: "00000000-0000-0000-0000-000000000000" },
      ]),
    });
    const child = spawnSync(
      testNodeExecPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(resolveCoordinatorModuleUrl())})`,
      ],
      {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
      },
    );

    expect(child.stdout).toBe("");
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(`Invalid inherited Vitest resource root: ${staleRoot}`);
  });

  it("ignores an unpaired production lock root marker", () => {
    const changedHome = tempDirs.make("openclaw-unpaired-production-root-");
    const spoofedRoot = path.join(changedHome, "spoofed-locks");
    const result = runCoordinatorSource(
      `
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        console.log(JSON.stringify({ runtimeDirectory: coordinatorModule.resolveStateLifecycleRuntimeDirectory() }));
      `,
      {
        VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT: spoofedRoot,
        HOME: changedHome,
        USERPROFILE: changedHome,
      },
      ["VITEST_OPENCLAW_RESOURCE_ROOT", "VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN"],
    );
    const expectedRoot =
      process.platform === "win32"
        ? path.join(changedHome, "AppData", "Local", "OpenClaw", "locks")
        : "/tmp";

    expect(result).toEqual({ runtimeDirectory: expectedRoot });
  });

  it("ignores unrelated resource-owner metadata outside the captured root", () => {
    const globalRuntime = resolveStateLifecycleRuntimeDirectory();
    fs.mkdirSync(globalRuntime, { recursive: true });
    const root = tempDirs.make(
      "openclaw-unrelated-resource-owner-",
      fs.realpathSync(globalRuntime),
    );
    const runtimeAncestor = path.join(root, "runtime-ancestor");
    const metadata = path.join(runtimeAncestor, ".vitest-resource-owner");
    fs.mkdirSync(path.join(metadata, "claims"), { recursive: true });
    fs.writeFileSync(path.join(metadata, "owner"), "not-a-valid-owner");
    const runtimeDirectory = path.join(runtimeAncestor, "runtime");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const coordinator = acquireStateDatabaseCoordinator({
      databasePath,
      runtimeDirectory,
      busyTimeoutMs: 0,
    });
    try {
      expect(coordinator.path.startsWith(`${runtimeDirectory}${path.sep}`)).toBe(true);
    } finally {
      coordinator.release();
    }
  });

  it("keeps external databases on the stable global coordinator and contends there", () => {
    const globalRuntime = resolveStateLifecycleRuntimeDirectory();
    fs.mkdirSync(globalRuntime, { recursive: true });
    const root = tempDirs.make("openclaw-external-state-", fs.realpathSync(globalRuntime));
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const coordinator = acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 });
    const expectedStatePath = resolveStateDatabaseCoordinatorPath({
      databasePath,
      runtimeDirectory: globalRuntime,
      uid: process.getuid?.(),
    });
    const expectedPath = expectedStatePath.replace("state-lifecycle.", "gateway-lifecycle.");

    try {
      expect(resolveStateLifecycleRuntimeDirectory(databasePath)).toBe(globalRuntime);
      expect(coordinator.path).toBe(expectedPath);
      const child = runCoordinatorPeer(databasePath, path.join(root, "changed-tmp"));
      expect(child).toMatchObject({
        runtimeDirectory: globalRuntime,
        errorName: "StateDatabaseCoordinatorContentionError",
      });
    } finally {
      coordinator.release();
      fs.rmSync(expectedPath, { force: true });
    }
  });

  it("inherits one resource root across child TMPDIR and VITEST changes", () => {
    const ownedRoot = fs.realpathSync(process.env.VITEST_OPENCLAW_RESOURCE_ROOT!);
    const root = tempDirs.make("openclaw-stable-resource-root-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const coordinator = acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 });
    try {
      expect(runCoordinatorPeer(databasePath, path.join(root, "changed-tmp"))).toMatchObject({
        runtimeDirectory: ownedRoot,
        errorName: "StateDatabaseCoordinatorContentionError",
      });
    } finally {
      coordinator.release();
    }
  });

  it("keeps owned coordination in post-setup spawned and forked descendants", async ({
    signal: testSignal,
  }) => {
    const ownedRoot = fs.realpathSync(process.env.VITEST_OPENCLAW_RESOURCE_ROOT!);
    expect(process.env.NODE_OPTIONS).toBe(`--import=${resourceContextPreload}`);
    const fixtureRoot = tempDirs.make("openclaw-post-setup-descendant-");
    const databasePath = path.join(ownedRoot, "post-setup-descendant", "openclaw.sqlite");
    const entry = path.join(fixtureRoot, "probe.mts");
    fs.writeFileSync(
      entry,
      `
        import fs from "node:fs";
        import path from "node:path";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const claims = path.join(${JSON.stringify(ownedRoot)}, ".vitest-resource-owner", "claims");
        // Observe only this child's real admissions, not parallel workers' registry writes.
        const admitted = [];
        const mkdirSync = fs.mkdirSync;
        fs.mkdirSync = (...args) => {
          const result = mkdirSync(...args);
          if (path.dirname(String(args[0])) === claims) admitted.push(String(args[0]));
          return result;
        };
        let coordinator;
        try {
          coordinator = coordinatorModule.acquireGatewayLifecycleCoordinator({
            databasePath: ${JSON.stringify(databasePath)},
            busyTimeoutMs: 0,
          });
        } finally {
          fs.mkdirSync = mkdirSync;
        }
        const pending = admitted.length === 1 && !fs.existsSync(path.join(admitted[0], "released"));
        coordinator.release();
        console.log(JSON.stringify({
          path: coordinator.path,
          pending,
          released: admitted.length === 1 && fs.existsSync(path.join(admitted[0], "released")),
          runtimeDirectory: coordinatorModule.resolveStateLifecycleRuntimeDirectory(${JSON.stringify(databasePath)}),
        }));
      `,
    );
    const execArgv = ["--disable-warning=DEP0205", "--import", "tsx"];
    const spawned = spawnSync(testNodeExecPath, [...execArgv, entry], {
      cwd: repositoryRoot,
      env: process.env,
      encoding: "utf8",
    });
    expect(spawned.stderr).toBe("");
    expect(spawned.status).toBe(0);

    const forked = fork(entry, [], {
      cwd: repositoryRoot,
      env: process.env,
      execArgv,
      execPath: testNodeExecPath,
      signal: testSignal,
      silent: true,
    });
    let forkedOutput = "";
    let forkedErrors = "";
    forked.stdout!.on("data", (chunk) => {
      forkedOutput += chunk;
    });
    forked.stderr!.on("data", (chunk) => {
      forkedErrors += chunk;
    });
    const forkedExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        forked.once("close", (code, signal) => resolve({ code, signal }));
        forked.once("error", reject);
      },
    );
    expect(forkedErrors).toBe("");
    expect(forkedExit).toEqual({ code: 0, signal: null });

    for (const output of [spawned.stdout, forkedOutput]) {
      const result = JSON.parse(output) as {
        path: string;
        pending: boolean;
        released: boolean;
        runtimeDirectory: string;
      };
      expect(result).toMatchObject({ pending: true, released: true, runtimeDirectory: ownedRoot });
      expect(result.path.startsWith(`${ownedRoot}${path.sep}`)).toBe(true);
    }
  });
});

function runCoordinatorPeer(databasePath: string, changedTmp: string) {
  fs.mkdirSync(changedTmp, { recursive: true });
  const moduleUrl = pathToFileURL(
    path.join(import.meta.dirname, "state-database-coordinator.ts"),
  ).href;
  const source = `
    process.env.TMPDIR = ${JSON.stringify(changedTmp)};
    process.env.TMP = ${JSON.stringify(changedTmp)};
    process.env.TEMP = ${JSON.stringify(changedTmp)};
    process.env.HOME = ${JSON.stringify(changedTmp)};
    process.env.USERPROFILE = ${JSON.stringify(changedTmp)};
    delete process.env.VITEST;
    const coordinator = await import(${JSON.stringify(moduleUrl)});
    const runtimeDirectory = coordinator.resolveStateLifecycleRuntimeDirectory(${JSON.stringify(databasePath)});
    let errorName;
    try {
      coordinator.acquireGatewayLifecycleCoordinator({ databasePath: ${JSON.stringify(databasePath)}, busyTimeoutMs: 0 });
    } catch (error) {
      errorName = error?.name;
    }
    console.log(JSON.stringify({ runtimeDirectory, errorName }));
  `;
  const env = withResourceContextPreload({ ...process.env });
  delete env.VITEST;
  const child = spawnSync(
    testNodeExecPath,
    ["--disable-warning=DEP0205", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: repositoryRoot, env, encoding: "utf8" },
  );
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as { runtimeDirectory: string; errorName?: string };
}
