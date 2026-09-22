import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type * as VerifierImplementation from "./openclaw-database-verify.impl.js";
import { startOpenClawDatabaseIntegrityVerifier } from "./openclaw-database-verify.js";
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
  OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS: 1,
  OPENCLAW_DATABASE_VERIFY_INTERVAL_MS: 100,
}));

describe("database verifier shutdown", () => {
  beforeEach(() => {
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
      await vi.advanceTimersByTimeAsync(1);
      await entered.promise;
      let stopped = false;
      const stopping = verifier.stop().then(() => {
        stopped = true;
      });
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
    await vi.advanceTimersByTimeAsync(1);
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
