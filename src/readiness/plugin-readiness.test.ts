import { describe, expect, it, vi } from "vitest";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { createPluginReadinessResolver } from "./plugin-readiness.js";

function registration(
  check: PluginReadinessCriterionRegistration["criterion"]["check"],
): PluginReadinessCriterionRegistration {
  return {
    id: "plugin.storage.backend",
    pluginId: "storage",
    criterion: {
      id: "backend",
      description: "Reports storage backend availability.",
      check,
    },
    source: "/plugins/storage/index.js",
  };
}

describe("createPluginReadinessResolver", () => {
  it("evaluates registered criteria as advisory and coalesces cached calls", async () => {
    const check = vi.fn(() => ({
      status: "True" as const,
      reason: "StorageReady",
      message: "Storage is ready.",
    }));
    const criterion = registration(check);
    const resolve = createPluginReadinessResolver();
    const registry = { readinessCriteria: [criterion] };
    const config = {};

    const first = await resolve({ registry, config });
    const second = await resolve({ registry, config });

    expect(first.conditions).toEqual([
      expect.objectContaining({
        type: "plugin.storage.backend",
        subjectRef: "plugin.storage/criterion/backend",
        status: "True",
        requirement: "advisory",
      }),
    ]);
    expect(first.subjects).toContainEqual({
      ref: "plugin.storage/criterion/backend",
      kind: "plugin.storage.criterion",
    });
    expect(second).toEqual(first);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("turns timeout and thrown errors into stable unknown evidence", async () => {
    const timeoutCriterion = registration(() => new Promise(() => {}));
    const resolveTimeout = createPluginReadinessResolver({ timeoutMs: 5, cacheTtlMs: 0 });
    const {
      conditions: [timedOut],
    } = await resolveTimeout({
      registry: { readinessCriteria: [timeoutCriterion] },
      config: {},
    });
    expect(timedOut).toMatchObject({ status: "Unknown", reason: "CriterionTimedOut" });

    const failedCriterion = registration(() => {
      throw new Error("backend offline");
    });
    const resolveFailure = createPluginReadinessResolver({ cacheTtlMs: 0 });
    const {
      conditions: [failed],
    } = await resolveFailure({
      registry: { readinessCriteria: [failedCriterion] },
      config: {},
    });
    expect(failed).toMatchObject({ status: "Unknown", reason: "CriterionCheckFailed" });
  });

  it("does not overlap a timed-out callback that ignores cancellation", async () => {
    let currentTime = 0;
    const check = vi.fn(() => new Promise<never>(() => {}));
    const criterion = registration(check);
    const registry = { readinessCriteria: [criterion] };
    const config = {};
    const resolve = createPluginReadinessResolver({
      timeoutMs: 5,
      cacheTtlMs: 10,
      now: () => currentTime,
    });

    const {
      conditions: [first],
    } = await resolve({ registry, config });
    currentTime = 20;
    const {
      conditions: [afterCacheExpiry],
    } = await resolve({
      registry,
      config,
    });

    expect(first).toMatchObject({ status: "Unknown", reason: "CriterionTimedOut" });
    expect(afterCacheExpiry).toEqual(first);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable until a retired callback settles, then evaluates its replacement", async () => {
    let resolveRetired:
      | ((value: { status: "True"; reason: string; message: string }) => void)
      | undefined;
    let retiredSignal: AbortSignal | undefined;
    const retired = registration(
      ({ signal }) =>
        new Promise((resolve) => {
          retiredSignal = signal;
          resolveRetired = resolve;
        }),
    );
    const replacementCheck = vi.fn(() => ({
      status: "False" as const,
      reason: "ReplacementUnavailable",
      message: "Replacement is unavailable.",
    }));
    const replacement = registration(replacementCheck);
    const resolve = createPluginReadinessResolver({ timeoutMs: 1_000, cacheTtlMs: 0 });

    const retiredResult = resolve({
      registry: { readinessCriteria: [retired] },
      config: {},
    });
    await vi.waitFor(() => expect(resolveRetired).toBeTypeOf("function"));
    const blockedReplacement = await resolve({
      registry: { readinessCriteria: [replacement] },
      config: {},
    });
    expect(blockedReplacement.conditions[0]).toMatchObject({
      status: "Unknown",
      reason: "CriterionEvaluationPending",
    });
    expect(replacementCheck).not.toHaveBeenCalled();

    resolveRetired?.({
      status: "True",
      reason: "RetiredReady",
      message: "Retired runtime is ready.",
    });

    await expect(retiredResult).resolves.toMatchObject({
      conditions: [expect.objectContaining({ reason: "RetiredReady" })],
    });
    await Promise.resolve();
    expect(retiredSignal?.aborted).toBe(true);

    const replacementResult = await resolve({
      registry: { readinessCriteria: [replacement] },
      config: {},
    });
    expect(replacementResult.conditions[0]).toMatchObject({
      status: "False",
      reason: "ReplacementUnavailable",
    });
    expect(replacementCheck).toHaveBeenCalledTimes(1);
  });

  it("retries after the timed-out callback settles and the cache expires", async () => {
    let currentTime = 0;
    let settle: (() => void) | undefined;
    const check = vi.fn(
      () =>
        new Promise<{ status: "True"; reason: string; message: string }>((resolve) => {
          settle = () => resolve({ status: "True", reason: "StorageReady", message: "Ready." });
        }),
    );
    const criterion = registration(check);
    const registry = { readinessCriteria: [criterion] };
    const config = {};
    const resolve = createPluginReadinessResolver({
      timeoutMs: 5,
      cacheTtlMs: 10,
      now: () => currentTime,
    });

    await resolve({ registry, config });
    settle?.();
    await new Promise((resolveSettled) => {
      setTimeout(resolveSettled, 0);
    });
    currentTime = 20;
    await resolve({ registry, config });

    expect(check).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed and oversized provider output", async () => {
    const malformed = registration(() => ({
      status: "False",
      reason: "Bad\nReason",
      message: "password=super-secret-value-that-must-not-escape",
    }));
    const oversized = registration(() => ({
      status: "False",
      reason: "StorageUnavailable",
      message: "x".repeat(513),
    }));
    const resolve = createPluginReadinessResolver({ cacheTtlMs: 0 });

    await expect(
      resolve({ registry: { readinessCriteria: [malformed] }, config: {} }),
    ).resolves.toMatchObject({
      conditions: [
        expect.objectContaining({ status: "Unknown", reason: "CriterionInvalidResult" }),
      ],
    });
    await expect(
      resolve({ registry: { readinessCriteria: [oversized] }, config: {} }),
    ).resolves.toMatchObject({
      conditions: [
        expect.objectContaining({ status: "Unknown", reason: "CriterionInvalidResult" }),
      ],
    });
  });

  it("redacts secrets from otherwise valid provider messages", async () => {
    const criterion = registration(() => ({
      status: "False",
      reason: "StorageUnavailable",
      message: "Storage failed with password=super-secret-value-that-must-not-escape",
    }));
    const resolve = createPluginReadinessResolver({ cacheTtlMs: 0 });

    const {
      conditions: [condition],
    } = await resolve({
      registry: { readinessCriteria: [criterion] },
      config: {},
    });

    expect(condition).toMatchObject({ status: "False", reason: "StorageUnavailable" });
    expect(condition?.message).not.toContain("super-secret-value-that-must-not-escape");
  });

  it("rejects secret-shaped provider reasons before projection", async () => {
    const secretReason = "sk-testsecret1234567890abcd";
    const criterion = registration(() => ({
      status: "False",
      reason: secretReason,
      message: "Storage is unavailable.",
    }));
    const resolve = createPluginReadinessResolver({ cacheTtlMs: 0 });

    const result = await resolve({
      registry: { readinessCriteria: [criterion] },
      config: {},
    });

    expect(result.conditions[0]).toMatchObject({
      status: "Unknown",
      reason: "CriterionInvalidResult",
    });
    expect(JSON.stringify(result)).not.toContain(secretReason);
  });

  it("reconciles provider-declared subjects and rejects unresolved references", async () => {
    const declared = registration(({ subjects }) => {
      const backend = subjects.declare({
        kind: "backend",
        key: "primary",
        identity: { id: "account-7", generation: "config-42" },
      });
      return {
        subjectRef: backend,
        relatedSubjectRefs: ["openclaw/config/active"],
        status: "True",
        reason: "StorageReady",
        message: "Storage is ready.",
      };
    });
    const unresolved = registration(() => ({
      subjectRef: "plugin.storage/backend/missing",
      status: "True",
      reason: "StorageReady",
      message: "Storage is ready.",
    }));
    const resolve = createPluginReadinessResolver({ cacheTtlMs: 0 });

    const declaredResult = await resolve({
      registry: { readinessCriteria: [declared] },
      config: {},
    });
    expect(declaredResult.conditions[0]).toMatchObject({
      subjectRef: "plugin.storage/backend/primary",
      relatedSubjectRefs: ["openclaw/config/active"],
    });
    expect(declaredResult.subjects).toContainEqual({
      ref: "plugin.storage/backend/primary",
      kind: "plugin.storage.backend",
      id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      generation: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });

    const invalidResult = await resolve({
      registry: { readinessCriteria: [unresolved] },
      config: {},
    });
    expect(invalidResult.conditions[0]).toMatchObject({
      subjectRef: "plugin.storage/criterion/backend",
      status: "Unknown",
      reason: "CriterionInvalidResult",
    });
  });
});
