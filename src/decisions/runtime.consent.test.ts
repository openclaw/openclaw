import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { captureGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { answer, batch, config, options, registered } from "./runtime.test-support.js";
import type { DecisionProviderV1 } from "./types.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

describe("decision consumer consent", () => {
  it("rejects withdrawn admission before provider invocation and preserves health", async () => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    const host = registered(evaluate);
    expect(await host.run({ ...options(), admit: () => false })).toEqual({
      status: "unavailable",
      reason: "disabled",
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(await host.run({ ...options(), admit: () => true })).toMatchObject({ status: "ok" });
    expect(host.registry.decisionProviders[0]?.host.inspect(config).callable).toBe(true);
  });

  it.each([false, true])(
    "checks consent after awaited network preparation (withdrawn: %s)",
    async (withdraw) => {
      let allowed = true;
      const preparing = createDeferredCore();
      const release = createDeferredCore();
      const fetch = vi.fn(async () => new Response("ok"));
      let retained: (() => void) | undefined;
      const host = registered(async () => {
        retained = captureGuardedFetchRequestAuthority();
        try {
          const result = await fetchWithSsrFGuard({
            url: "https://decision.example/evaluate",
            fetchImpl: fetch,
            lookupFn: async () => {
              preparing.resolve();
              await release.promise;
              return [{ address: "93.184.216.34", family: 4 }];
            },
            init: { method: "POST", body: JSON.stringify(batch) },
          });
          await result.response.body?.cancel();
          await result.release();
          return answer;
        } catch {
          // Provider adapters may translate the transport exception and even see a
          // later re-enable. Neither can revive this evaluation or poison health.
          allowed = true;
          return { status: "unavailable", reason: "transport" };
        }
      });
      const pending = host.run({ ...options(), admit: () => allowed });
      await preparing.promise;
      allowed = !withdraw;
      release.resolve();
      expect(await pending).toMatchObject(
        withdraw ? { status: "unavailable", reason: "disabled" } : { status: "ok" },
      );
      expect(fetch).toHaveBeenCalledTimes(withdraw ? 0 : 1);
      expect(retained).toBeTypeOf("function");
      expect(() => retained?.()).toThrow("no longer active");
      expect(host.registry.decisionProviders[0]?.host.inspect(config).callable).toBe(true);
    },
  );

  it.each(["denied", "invalid"] as const)(
    "preserves %s admission through translated errors and overdue cleanup",
    async (kind) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      onTestFinished(() => clock.mockRestore());
      let rejectAdmission = false;
      const host = registered(async () => {
        rejectAdmission = true;
        try {
          captureGuardedFetchRequestAuthority()?.();
        } catch {
          rejectAdmission = false;
          clock.mockReturnValue(1_001);
          return { status: "unavailable", reason: "transport" };
        }
        return answer;
      });
      const pending = host.run({
        ...options(),
        admit: () => {
          if (rejectAdmission && kind === "invalid") {
            throw new Error("private callback diagnostics");
          }
          return !rejectAdmission;
        },
      });
      if (kind === "invalid") {
        await expect(pending).rejects.toThrow("Invalid decision contract");
      } else {
        expect(await pending).toEqual({ status: "unavailable", reason: "disabled" });
      }
      const health = host.registry.decisionProviders[0]?.host.inspect(config);
      expect(health?.callable).toBe(true);
      expect(health?.reasons.deadline).toBeUndefined();
    },
  );

  it("discards a successful answer after consent withdrawal", async () => {
    let allowed = true;
    const release = createDeferredCore();
    const host = registered(async () => {
      await release.promise;
      return answer;
    });
    const pending = host.run({ ...options(), admit: () => allowed });
    await host.started;
    allowed = false;
    release.resolve();
    expect(await pending).toEqual({ status: "unavailable", reason: "disabled" });
    expect(host.registry.decisionProviders[0]?.host.inspect(config).successCount).toBe(0);
  });

  it.each([
    () => undefined,
    () => Promise.reject(new Error("private callback detail")),
    () => {
      throw new Error("private callback detail");
    },
  ])("fails closed on invalid admission callbacks", async (admit) => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    const host = registered(evaluate);
    // Deliberately cross the typed boundary to exercise invalid JavaScript callers.
    const invalidAdmission = admit as unknown as () => boolean;
    await expect(host.run({ ...options(), admit: invalidAdmission })).rejects.toThrow(
      "Invalid decision contract",
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("rechecks admission after synchronous provider readiness", async () => {
    let allowed = true;
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    const host = registered(evaluate, () => {
      allowed = false;
      return true;
    });
    expect(await host.run({ ...options(), admit: () => allowed })).toEqual({
      status: "unavailable",
      reason: "disabled",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });
});
