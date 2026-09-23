/** Real helper IPC/SQLite; the disposable parent is NOT an installed serving Gateway. */
import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as handoffLease from "../../infra/update-managed-service-handoff-lease.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  cancelManagedServiceUpdateHandoffMock,
  detectRespawnSupervisorMock,
  invokeUpdateRun,
  mockGlobalInstallSurface,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

// Wrap the real spawn without trying to redefine Node's immutable ESM namespace.
vi.mock("node:child_process", { spy: true });

it.runIf(process.platform !== "win32")(
  "joins the accepted real helper and clears its exact lease before rethrowing projection failure",
  async () => {
    // openclaw-temp-dir: allow preserves backing if the real helper cannot settle.
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pr148117-real-cancel-")),
    );
    const tmp = await import("../../infra/tmp-openclaw-dir.js");
    const tempRoot = vi.spyOn(tmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(root);
    const databasePath = path.join(root, "managed-update-handoffs.sqlite");
    const leasePath = vi
      .spyOn(handoffLease, "resolveManagedUpdateLeaseDatabasePath")
      .mockReturnValue(databasePath);
    const actual = await vi.importActual<
      typeof import("../../infra/update-managed-service-handoff.js")
    >("../../infra/update-managed-service-handoff.js");
    const parent = childProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const parentClosed = once(parent, "close");
    const spawned = vi.mocked(childProcess.spawn);
    let helperProcess: childProcess.ChildProcess | undefined;
    let helperClosed: Promise<unknown> | undefined;
    const beforePark = vi.fn(async () => {});
    const original = new Error("pr148117-original-result-projection-error");
    let helper: Awaited<ReturnType<typeof actual.startManagedServiceUpdateHandoff>> | undefined;
    let identity: Parameters<typeof actual.cancelManagedServiceUpdateHandoff>[0] | undefined;
    let releaseCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let cancellationTask: ReturnType<typeof actual.cancelManagedServiceUpdateHandoff> | undefined;
    const cancellationEntered = createDeferred();
    let cancellationSettled = false;
    let handlerSettled = false;
    let pending: Promise<unknown> | undefined;
    let cleanupError: unknown;
    let projection: { mockRestore: () => void } | undefined;
    try {
      // Resolve the physical parent before any helper can open its SQLite store.
      expect(
        await fs.realpath(path.dirname(handoffLease.resolveManagedUpdateLeaseDatabasePath())),
      ).toBe(root);
      const sharedRoot = await fs
        .realpath("/tmp/openclaw")
        .catch(() => path.resolve("/tmp/openclaw"));
      expect(root).not.toBe(sharedRoot);
      await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
      const updaterPath = path.join(root, "never-run.cjs");
      await fs.writeFile(updaterPath, 'throw new Error("Updater must not run before transfer");');
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockGlobalInstallSurface();
      startManagedServiceUpdateHandoffMock.mockImplementationOnce(async (params) => {
        const serviceEnv = {
          ...process.env,
          OPENCLAW_STATE_DIR: path.join(root, "state-owner"),
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.pr148117-isolated-probe",
        };
        // The helper receives this resolved state path in its sealed parameters.
        // Its handoff store and state store must both remain physically private.
        const stateDatabasePath = resolveOpenClawStateSqlitePath(serviceEnv);
        await fs.mkdir(path.dirname(stateDatabasePath), { recursive: true });
        expect(await fs.realpath(path.dirname(stateDatabasePath))).toBe(
          path.join(root, "state-owner", "state"),
        );
        expect(stateDatabasePath).toBe(path.join(root, "state-owner", "state", "openclaw.sqlite"));
        helper = await actual.startManagedServiceUpdateHandoff({
          ...params,
          root,
          supervisor: "launchd",
          env: serviceEnv,
          parentPid: expectDefined(parent.pid, "disposable parent pid"),
          execPath: process.execPath,
          argv1: updaterPath,
          // This pre-transfer child owns only its real lease, not a fixture ledger writer.
          runId: undefined,
          meta: {},
          beforePark,
          timeoutMs: 10_000,
        });
        expect(helper.status).toBe("started");
        if (helper.status !== "started") {
          throw new Error("Expected fresh accepted helper");
        }
        identity = {
          kind: "managed-update-handoff",
          handoffId: helper.handoffId,
          installRoot: helper.installRoot,
        };
        // Retain the actual ChildProcess handle so failure cleanup cannot signal a reused PID.
        helperProcess = spawned.mock.results
          .filter((result) => result.type === "return")
          .map((result) => result.value)
          .find((child) => child.pid === helper?.pid);
        helperClosed = once(expectDefined(helperProcess, "owned helper process"), "close");
        projection = vi.spyOn(ledger, "recordUpdateRunPhase").mockImplementationOnce(() => {
          throw original;
        });
        return helper;
      });
      cancelManagedServiceUpdateHandoffMock.mockImplementationOnce((owner) => {
        cancellationTask = (async () => {
          expect(owner).toEqual(identity);
          cancellationEntered.resolve();
          await cancellationGate;
          const result = await actual.cancelManagedServiceUpdateHandoff(owner);
          expect(result).toBe("restored-in-process");
          cancellationSettled = true;
          return result;
        })();
        return cancellationTask;
      });
      pending = withEnvAsync(
        { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.pr148117-isolated-probe" },
        () => invokeUpdateRun({}),
      ).then(
        () => {
          handlerSettled = true;
          return null;
        },
        (error: unknown) => {
          handlerSettled = true;
          return error;
        },
      );
      await Promise.race([
        cancellationEntered.promise,
        pending.then(() => {
          throw new Error("Handler settled without entering cancellation");
        }),
      ]);
      expect(handlerSettled).toBe(false);
      expect(cancellationSettled).toBe(false);
      const accepted = expectDefined(helper, "accepted helper");
      const owner = expectDefined(identity, "accepted identity");
      expect(isPidAlive(expectDefined(accepted.pid, "helper pid"))).toBe(true);
      const leaseStore = handoffLease.createManagedHandoffLeaseStore({
        databasePath,
        serviceManagerEnv: process.env,
      });
      expect(await fs.realpath(databasePath)).toBe(databasePath);
      const parentIdentity = leaseStore.processIdentity(expectDefined(parent.pid, "parent pid"));
      const lease = leaseStore.read(owner.installRoot);
      expect(lease.kind).toBe("current");
      if (lease.kind !== "current") {
        throw new Error("Expected accepted durable lease");
      }
      expect(lease.lease.owner).toBe(owner.handoffId);
      expect(lease.lease.helper.pid).toBe(accepted.pid);
      expect(leaseStore.isProcessIdentityCurrent(lease.lease.helper)).toBe(true);
      expect(leaseStore.isProcessIdentityCurrent(lease.lease.executor)).toBe(true);
      expect(lease.lease.executor).toEqual(lease.lease.helper);
      console.info("accepted-helper", {
        helper: lease.lease.helper,
        executor: lease.lease.executor,
        parent: parentIdentity,
      });
      releaseCancellation();
      expect(await pending).toBe(original);
      expect(cancellationSettled).toBe(true);
      expect(leaseStore.isProcessIdentityCurrent(lease.lease.helper)).toBe(false);
      expect(leaseStore.isProcessIdentityCurrent(lease.lease.executor)).toBe(false);
      expect(leaseStore.isProcessIdentityCurrent(parentIdentity)).toBe(true);
      expect(projection).toHaveBeenCalledTimes(1);
      expect(isPidAlive(expectDefined(accepted.pid, "helper pid"))).toBe(false);
      expect(
        handoffLease
          .createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: process.env })
          .read(owner.installRoot).kind,
      ).toBe("absent");
      expect(parent.exitCode).toBeNull();
      expect(parent.signalCode).toBeNull();
      expect(beforePark).not.toHaveBeenCalled();
      expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    } finally {
      releaseCancellation();
      // On a failing path, dependent RPC/cancellation promises may be waiting on
      // this exact child. Join its exit before waiting for those promises.
      if (helperProcess) {
        if (helperProcess.exitCode === null && helperProcess.signalCode === null) {
          helperProcess.kill("SIGKILL");
        }
        await helperClosed;
      }
      parent.stdin?.end();
      await parentClosed;
      const cleanupResults = await Promise.allSettled([pending, cancellationTask]);
      cleanupError = cleanupResults.find((result) => result.status === "rejected")?.reason;
      // The normal owner retires its stale lease after the exact child has closed.
      try {
        if (identity) {
          await actual.cancelManagedServiceUpdateHandoff(identity);
        }
      } catch (error) {
        cleanupError ??= error;
      }
      spawned.mockRestore();
      projection?.mockRestore();
      // Preserve unsettled helper backing and the original test failure, if any.
      const settled = !helper?.pid || !isPidAlive(helper.pid);
      leasePath.mockRestore();
      tempRoot.mockRestore();
      if (settled) {
        if (helper) {
          await fs.rm(path.dirname(helper.logPath), { recursive: true, force: true });
        }
        await fs.rm(root, { recursive: true, force: true });
      } else {
        cleanupError ??= new Error(`Unsettled owned helper retained: ${root}; ${helper?.logPath}`);
        console.error(cleanupError);
      }
    }
    if (cleanupError) {
      throw new Error("Real-helper probe cleanup failed", { cause: cleanupError });
    }
  },
  45_000,
);
