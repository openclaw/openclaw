import { ChildProcess } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createDeferredCore } from "../shared/deferred.js";
import type * as VerifierImplementation from "./openclaw-database-verify.impl.js";
import {
  requestOpenClawAgentDatabaseIntegrityCheck,
  startOpenClawDatabaseIntegrityVerifier,
} from "./openclaw-database-verify.js";
import type { OpenClawDatabaseVerifyResult } from "./openclaw-database-verify.worker.js";

const mocks = vi.hoisted(() => ({
  runDatabaseVerifyWorker: vi.fn<typeof VerifierImplementation.runDatabaseVerifyWorker>(),
  terminateDatabaseVerifyWorker:
    vi.fn<typeof VerifierImplementation.terminateDatabaseVerifyWorker>(),
  applyOpenClawDatabaseVerificationResults:
    vi.fn<typeof VerifierImplementation.applyOpenClawDatabaseVerificationResults>(),
}));

vi.mock("./openclaw-database-verify.impl.js", () => ({
  ...mocks,
}));

describe("database verifier shutdown", () => {
  beforeEach(async () => {
    await import("./openclaw-database-verify.impl.js");
    vi.useFakeTimers();
    vi.resetAllMocks();
    mocks.terminateDatabaseVerifyWorker.mockResolvedValue(undefined);
    mocks.applyOpenClawDatabaseVerificationResults.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels proof publication waiting for startup admission before releasing its writer", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/preparation-shutdown" };
    const pathname = path.resolve("/synthetic/preparing.sqlite");
    const preparation = createDeferredCore();
    const entered = createDeferredCore();
    const release = vi.fn(async () => {});
    let publication: Promise<boolean> | undefined;
    mocks.runDatabaseVerifyWorker.mockResolvedValue([{ path: pathname, ok: true }]);
    mocks.applyOpenClawDatabaseVerificationResults.mockImplementation(async (options) => {
      await options.onVerified?.(pathname);
    });
    requestOpenClawAgentDatabaseIntegrityCheck({
      check: "full",
      env,
      path: pathname,
      release,
      proof: {
        identity: "synthetic",
        complete: (_assertCurrent, signal) => {
          publication = racePromiseWithAbortSignal(preparation.promise, signal).then(() => true);
          entered.resolve();
          return publication;
        },
      },
    });
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await entered.promise;
      expect(release).not.toHaveBeenCalled();
      await verifier.stop();
      await expect(publication).rejects.toMatchObject({ name: "AbortError" });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      preparation.resolve();
      await verifier.stop();
    }
  });

  it("releases superseded checks and joins final queued cleanup", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/queued-cleanup" };
    const cleanup = createDeferredCore();
    const previous = vi.fn(async () => {});
    const current = vi.fn(() => cleanup.promise);
    const ignored = vi.fn(async () => {});
    const request = { check: "full" as const, env, path: "/synthetic/retained.sqlite" };
    requestOpenClawAgentDatabaseIntegrityCheck({ ...request, release: previous });
    requestOpenClawAgentDatabaseIntegrityCheck({ ...request, release: current });
    requestOpenClawAgentDatabaseIntegrityCheck({ ...request, check: "quick", release: ignored });
    expect(previous).toHaveBeenCalledOnce();
    expect(ignored).toHaveBeenCalledOnce();
    expect(current).not.toHaveBeenCalled();
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    let stopped = false;
    const stopping = verifier.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(current).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    cleanup.resolve();
    await stopping;
    expect(mocks.runDatabaseVerifyWorker).not.toHaveBeenCalled();
  });

  it.each(["success", "failure", "stop"] as const)(
    "holds active verification custody through %s settlement",
    async (outcome) => {
      const env = { OPENCLAW_STATE_DIR: `/synthetic/active-cleanup-${outcome}` };
      const results = createDeferredCore<OpenClawDatabaseVerifyResult[]>();
      const cleanup = createDeferredCore();
      const release = vi.fn(() => cleanup.promise);
      mocks.runDatabaseVerifyWorker.mockReturnValueOnce(results.promise).mockResolvedValue([]);
      requestOpenClawAgentDatabaseIntegrityCheck({
        check: "full",
        env,
        path: "/synthetic/retained.sqlite",
        release,
      });
      const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
      await vi.advanceTimersByTimeAsync(0);
      const stopping = outcome === "stop" ? verifier.stop() : undefined;
      expect(release).not.toHaveBeenCalled();
      if (outcome === "failure") {
        results.reject(new Error("synthetic scan failed"));
      } else {
        results.resolve([]);
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(release).toHaveBeenCalledOnce();
      cleanup.resolve();
      await stopping;
      await verifier.stop();
      expect(release).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("waits for listening startup, then checks both queued and late cached opens", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/queued" };
    const firstPath = path.resolve("/synthetic/first.sqlite");
    const latePath = path.resolve("/synthetic/late.sqlite");
    mocks.runDatabaseVerifyWorker.mockResolvedValue([]);
    requestOpenClawAgentDatabaseIntegrityCheck({ check: "quick", env, path: firstPath });
    requestOpenClawAgentDatabaseIntegrityCheck({ check: "full", env, path: firstPath });
    requestOpenClawAgentDatabaseIntegrityCheck({ check: "quick", env, path: firstPath });
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.runDatabaseVerifyWorker).not.toHaveBeenCalled();

    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runDatabaseVerifyWorker.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ kind: "agent", path: firstPath, check: "full" }),
      ]);
      requestOpenClawAgentDatabaseIntegrityCheck({ check: "quick", env, path: latePath });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runDatabaseVerifyWorker.mock.calls[1]?.[0]).toEqual([
        expect.objectContaining({ kind: "agent", path: latePath, check: "quick" }),
      ]);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 2 * 24 * 60 * 60_000);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await verifier.stop();
    }
  });

  it("discards final-stop work without clearing a replacement's queued checks during drainage", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/serial" };
    const results = createDeferredCore<OpenClawDatabaseVerifyResult[]>();
    mocks.runDatabaseVerifyWorker.mockReturnValueOnce(results.promise).mockResolvedValue([]);
    requestOpenClawAgentDatabaseIntegrityCheck({
      check: "quick",
      env,
      path: "/synthetic/first.sqlite",
    });
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    await vi.advanceTimersByTimeAsync(0);
    requestOpenClawAgentDatabaseIntegrityCheck({
      check: "quick",
      env,
      path: "/synthetic/late.sqlite",
    });
    const stopping = verifier.stop();
    const replacement = startOpenClawDatabaseIntegrityVerifier({ env });
    const replacementPath = path.resolve("/synthetic/replacement.sqlite");
    try {
      requestOpenClawAgentDatabaseIntegrityCheck({ check: "quick", env, path: replacementPath });
      await vi.advanceTimersByTimeAsync(10);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledOnce();
      results.resolve([]);
      await stopping;
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledTimes(2);
      expect(mocks.runDatabaseVerifyWorker.mock.calls[1]?.[0]).toEqual([
        expect.objectContaining({ path: replacementPath, check: "quick" }),
      ]);
      expect(mocks.applyOpenClawDatabaseVerificationResults).toHaveBeenCalledOnce();
    } finally {
      results.resolve([]);
      await Promise.all([verifier.stop(), replacement.stop()]);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks requested paths with the startup environment", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/queued-peers" };
    const capturedEnv = { ...env };
    const registeredPath = path.resolve("/synthetic/registered.sqlite");
    const unregisteredPath = path.resolve("/synthetic/unregistered.sqlite");
    mocks.runDatabaseVerifyWorker.mockResolvedValue([]);
    const first = startOpenClawDatabaseIntegrityVerifier({ env });
    try {
      requestOpenClawAgentDatabaseIntegrityCheck({ check: "quick", env, path: registeredPath });
      requestOpenClawAgentDatabaseIntegrityCheck({ check: "quick", env, path: unregisteredPath });
      env.OPENCLAW_STATE_DIR = "/synthetic/changed-after-start";
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledOnce();
      expect(mocks.applyOpenClawDatabaseVerificationResults).toHaveBeenCalledWith(
        expect.objectContaining({ env: capturedEnv }),
      );
      expect(mocks.runDatabaseVerifyWorker.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ path: registeredPath, check: "quick" }),
        expect.objectContaining({ path: unregisteredPath, check: "quick" }),
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await first.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues accepting cached opens after a failed quick-check child", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/retry" };
    mocks.runDatabaseVerifyWorker
      .mockRejectedValueOnce(new Error("synthetic child failure"))
      .mockResolvedValue([]);
    requestOpenClawAgentDatabaseIntegrityCheck({
      check: "quick",
      env,
      path: "/synthetic/first.sqlite",
    });
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    try {
      await vi.advanceTimersByTimeAsync(0);
      requestOpenClawAgentDatabaseIntegrityCheck({
        check: "quick",
        env,
        path: "/synthetic/late.sqlite",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledTimes(2);
      expect(mocks.applyOpenClawDatabaseVerificationResults).toHaveBeenCalledOnce();
    } finally {
      await verifier.stop();
    }
  });

  it.each(["draining", "confirming"] as const)(
    "joins result application and cancels its lifetime while %s",
    async (phase) => {
      const application = createDeferredCore();
      const entered = createDeferredCore();
      const child = new ChildProcess();
      let lifetime: VerifierImplementation.DatabaseVerifyWorkerLifetime | undefined;
      mocks.runDatabaseVerifyWorker.mockResolvedValue([]);
      mocks.applyOpenClawDatabaseVerificationResults.mockImplementation((options) => {
        lifetime = options.workerLifetime;
        if (phase === "confirming") {
          lifetime?.onWorker?.(child);
        }
        entered.resolve();
        return application.promise;
      });
      const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });
      requestOpenClawAgentDatabaseIntegrityCheck({
        check: "quick",
        env: {},
        path: "/synthetic/first.sqlite",
      });
      await vi.advanceTimersByTimeAsync(0);
      await entered.promise;
      requestOpenClawAgentDatabaseIntegrityCheck({
        check: "quick",
        env: {},
        path: "/synthetic/late.sqlite",
      });
      let stopped = false;
      const stopping = verifier.stop().then(() => {
        stopped = true;
      });
      try {
        try {
          await vi.advanceTimersByTimeAsync(100);
          expect(stopped).toBe(false);
          expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledOnce();
          if (phase === "confirming") {
            expect(mocks.terminateDatabaseVerifyWorker).toHaveBeenCalledExactlyOnceWith(child);
          } else {
            expect(mocks.terminateDatabaseVerifyWorker).not.toHaveBeenCalled();
          }
          expect(() => lifetime?.assertCurrent?.()).toThrow("database integrity verifier stopped");
        } finally {
          application.reject(new Error("synthetic confirmation failure"));
          await stopping;
        }
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledOnce();
      } finally {
        await verifier.stop();
      }
      expect(stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
