import { AsyncLocalStorage } from "node:async_hooks";
import { ChildProcess } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type * as VerifierImplementation from "./openclaw-database-verify.impl.js";
import {
  requestOpenClawAgentDatabaseQuickCheck,
  startOpenClawDatabaseIntegrityVerifier,
} from "./openclaw-database-verify.js";
import type { OpenClawDatabaseVerifyResult } from "./openclaw-database-verify.worker.js";

const mocks = vi.hoisted(() => ({
  collectOpenClawDatabaseVerifyTargets:
    vi.fn<typeof VerifierImplementation.collectOpenClawDatabaseVerifyTargets>(),
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
    mocks.collectOpenClawDatabaseVerifyTargets.mockReturnValue([
      { kind: "state", label: "synthetic state", path: "synthetic.sqlite" },
    ]);
    mocks.terminateDatabaseVerifyWorker.mockResolvedValue(undefined);
    mocks.applyOpenClawDatabaseVerificationResults.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for listening startup, then checks both queued and late cached opens", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/queued" };
    const firstPath = path.resolve("/synthetic/first.sqlite");
    const latePath = path.resolve("/synthetic/late.sqlite");
    mocks.runDatabaseVerifyWorker.mockResolvedValue([]);
    requestOpenClawAgentDatabaseQuickCheck({ env, path: firstPath });
    requestOpenClawAgentDatabaseQuickCheck({ env, path: firstPath });
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.runDatabaseVerifyWorker).not.toHaveBeenCalled();

    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runDatabaseVerifyWorker.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ kind: "agent", path: firstPath, check: "quick" }),
      ]);
      requestOpenClawAgentDatabaseQuickCheck({ env, path: latePath });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runDatabaseVerifyWorker.mock.calls[1]?.[0]).toEqual([
        expect.objectContaining({ kind: "agent", path: latePath, check: "quick" }),
      ]);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(mocks.runDatabaseVerifyWorker.mock.calls[2]?.[0]).toEqual([
        { kind: "state", label: "synthetic state", path: "synthetic.sqlite" },
      ]);
    } finally {
      await verifier.stop();
    }
  });

  it("discards final-stop work without clearing a replacement's queued checks during drainage", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/serial" };
    const results = createDeferredCore<OpenClawDatabaseVerifyResult[]>();
    mocks.runDatabaseVerifyWorker.mockReturnValueOnce(results.promise).mockResolvedValue([]);
    requestOpenClawAgentDatabaseQuickCheck({ env, path: "/synthetic/first.sqlite" });
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    await vi.advanceTimersByTimeAsync(0);
    requestOpenClawAgentDatabaseQuickCheck({ env, path: "/synthetic/late.sqlite" });
    const stopping = verifier.stop();
    const replacement = startOpenClawDatabaseIntegrityVerifier({ env });
    const replacementPath = path.resolve("/synthetic/replacement.sqlite");
    try {
      requestOpenClawAgentDatabaseQuickCheck({ env, path: replacementPath });
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

  it.each(["active", "standby"] as const)(
    "serializes same-root checks in the surviving Gateway context after %s stop",
    async (retiring) => {
      const env = { OPENCLAW_STATE_DIR: `/synthetic/handoff-${retiring}` };
      const context = new AsyncLocalStorage<string>();
      const workerContexts: Array<string | undefined> = [];
      const applicationContexts: Array<string | undefined> = [];
      const results = createDeferredCore<OpenClawDatabaseVerifyResult[]>();
      const child = new ChildProcess();
      mocks.runDatabaseVerifyWorker.mockImplementation((_targets, options) => {
        workerContexts.push(context.getStore());
        if (workerContexts.length === 1) {
          options?.onWorker?.(child);
          return results.promise.then((value) => {
            options?.onWorker?.(undefined);
            return value;
          });
        }
        return Promise.resolve([]);
      });
      mocks.applyOpenClawDatabaseVerificationResults.mockImplementation(async () => {
        applicationContexts.push(context.getStore());
      });
      const first = context.run("first", () => startOpenClawDatabaseIntegrityVerifier({ env }));
      const second = context.run("second", () => startOpenClawDatabaseIntegrityVerifier({ env }));
      const firstPath = path.resolve("/synthetic/first.sqlite");
      const latePath = path.resolve("/synthetic/late.sqlite");
      try {
        context.run("publisher", () =>
          requestOpenClawAgentDatabaseQuickCheck({ env, path: firstPath }),
        );
        await vi.advanceTimersByTimeAsync(0);
        requestOpenClawAgentDatabaseQuickCheck({ env, path: latePath });
        requestOpenClawAgentDatabaseQuickCheck({ env, path: latePath });
        let stopped = false;
        const stopping = (retiring === "active" ? first : second).stop().then(() => {
          stopped = true;
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(stopped).toBe(retiring === "standby");
        expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledOnce();
        expect(mocks.terminateDatabaseVerifyWorker).toHaveBeenCalledTimes(
          retiring === "active" ? 1 : 0,
        );
        results.resolve([]);
        await stopping;
        await vi.advanceTimersByTimeAsync(1);
        expect(workerContexts).toEqual(["first", retiring === "active" ? "second" : "first"]);
        expect(applicationContexts).toEqual(
          retiring === "active" ? ["second"] : ["first", "first"],
        );
        expect(
          mocks.runDatabaseVerifyWorker.mock.calls[1]?.[0].map((target) => target.path).toSorted(),
        ).toEqual((retiring === "active" ? [firstPath, latePath] : [latePath]).toSorted());
      } finally {
        results.resolve([]);
        await Promise.all([first.stop(), second.stop()]);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("shares the daily deadline and includes queued paths absent from the full inventory", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/daily-peers" };
    const capturedEnv = { ...env };
    const registeredPath = path.resolve("/synthetic/registered.sqlite");
    const unregisteredPath = path.resolve("/synthetic/unregistered.sqlite");
    const registered = {
      kind: "agent" as const,
      label: "synthetic registered agent",
      path: registeredPath,
    };
    mocks.collectOpenClawDatabaseVerifyTargets.mockReturnValue([registered]);
    mocks.runDatabaseVerifyWorker.mockResolvedValue([]);
    const first = startOpenClawDatabaseIntegrityVerifier({ env });
    const second = startOpenClawDatabaseIntegrityVerifier({ env });
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000);
      requestOpenClawAgentDatabaseQuickCheck({ env, path: registeredPath });
      requestOpenClawAgentDatabaseQuickCheck({ env, path: unregisteredPath });
      env.OPENCLAW_STATE_DIR = "/synthetic/changed-after-start";
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledOnce();
      expect(mocks.collectOpenClawDatabaseVerifyTargets).toHaveBeenCalledWith({ env: capturedEnv });
      expect(mocks.applyOpenClawDatabaseVerificationResults).toHaveBeenCalledWith(
        expect.objectContaining({ env: capturedEnv }),
      );
      expect(mocks.runDatabaseVerifyWorker.mock.calls[0]?.[0]).toEqual([
        registered,
        expect.objectContaining({ path: unregisteredPath, check: "quick" }),
      ]);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledTimes(2);
      expect(mocks.runDatabaseVerifyWorker.mock.calls[1]?.[0]).toEqual([registered]);
    } finally {
      await second.stop();
      await first.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues accepting cached opens after a failed quick-check child", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/retry" };
    mocks.runDatabaseVerifyWorker
      .mockRejectedValueOnce(new Error("synthetic child failure"))
      .mockResolvedValue([]);
    requestOpenClawAgentDatabaseQuickCheck({ env, path: "/synthetic/first.sqlite" });
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    try {
      await vi.advanceTimersByTimeAsync(0);
      requestOpenClawAgentDatabaseQuickCheck({ env, path: "/synthetic/late.sqlite" });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledTimes(2);
      expect(mocks.applyOpenClawDatabaseVerificationResults).toHaveBeenCalledOnce();
    } finally {
      await verifier.stop();
    }
  });

  it.each(["fulfilled", "rejected"] as const)(
    "joins %s result application after the child has exited",
    async (outcome) => {
      const application = createDeferredCore();
      const entered = createDeferredCore();
      mocks.runDatabaseVerifyWorker.mockResolvedValue([]);
      mocks.applyOpenClawDatabaseVerificationResults.mockImplementation(() => {
        entered.resolve();
        return application.promise;
      });
      const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await entered.promise;
      const peer = startOpenClawDatabaseIntegrityVerifier({ env: {} });
      requestOpenClawAgentDatabaseQuickCheck({ env: {}, path: "/synthetic/late.sqlite" });
      let stopped = false;
      const stopping = verifier.stop().then(() => {
        stopped = true;
      });
      try {
        try {
          await vi.advanceTimersByTimeAsync(100);
          expect(stopped).toBe(false);
          expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledOnce();
          expect(mocks.terminateDatabaseVerifyWorker).not.toHaveBeenCalled();
        } finally {
          if (outcome === "rejected") {
            application.reject(new Error("synthetic confirmation failure"));
          } else {
            application.resolve();
          }
          await stopping;
        }
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledTimes(2);
      } finally {
        await peer.stop();
      }
      expect(stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("joins the running turn after termination and skips results received during stop", async () => {
    const results = createDeferredCore<OpenClawDatabaseVerifyResult[]>();
    const child = new ChildProcess();
    mocks.runDatabaseVerifyWorker.mockImplementation((_targets, options) => {
      options?.onWorker?.(child);
      return results.promise;
    });
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    let stopped = false;
    const stopping = verifier.stop().then(() => {
      stopped = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(mocks.terminateDatabaseVerifyWorker).toHaveBeenCalledWith(child);
      expect(stopped).toBe(false);
    } finally {
      results.resolve([]);
      await stopping;
    }
    expect(mocks.applyOpenClawDatabaseVerificationResults).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
