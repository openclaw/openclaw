import { afterEach, describe, expect, it, vi } from "vitest";
import {
  releaseRuntimePluginWork,
  retainRuntimePluginWork,
} from "../agents/runtime-plugin-work.js";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstance } from "./plugin-instance.js";
import { withPluginRetentionOwner } from "./plugin-retention-diagnostics.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { PluginRuntimeCloseRetainedError } from "./runtime-close-error.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("plugin retained reference diagnostics", () => {
  it("captures separate acquisition owners and bounded payload-free snapshots", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const instance = new PluginInstance("fixture");
    const owner = {
      sessionKey: "session-a",
      runId: "run-a",
      payload: "private-prompt",
      secret: "private-secret",
    };
    const first = withPluginRetentionOwner(owner, () =>
      instance.retainWork("registry-construction"),
    );
    owner.sessionKey = "mutated";
    const second = withPluginRetentionOwner({ sessionKey: "session-b", runId: "run-b" }, () =>
      instance.retainWork("prepared-generation-lease"),
    );
    clock.mockReturnValue(1500);
    const snapshot = instance.retentionSnapshot();
    expect(snapshot.references).toMatchObject([
      {
        kind: "work",
        reason: "registry-construction",
        acquiredAtMs: 1000,
        ageMs: 500,
        owner: { sessionKey: "session-a", runId: "run-a" },
      },
      {
        kind: "work",
        reason: "prepared-generation-lease",
        owner: { sessionKey: "session-b", runId: "run-b" },
      },
    ]);
    expect(new Set(snapshot.references.map((row) => row.referenceId)).size).toBe(2);
    expect(JSON.stringify(snapshot)).not.toMatch(/private-prompt|private-secret|mutated/);
    snapshot.references[0]!.reason = "unknown";
    expect(instance.retentionSnapshot().references[0]!.reason).toBe("registry-construction");
    expect(instance.retentionSnapshot({ limit: 1 })).toMatchObject({ total: 2, omitted: 1 });
    expect(
      instance
        .retentionSnapshot({ includeOwners: false })
        .references.every((row) => row.owner === "unknown"),
    ).toBe(true);
    first();
    first();
    second();
    expect(instance.retentionSnapshot()).toMatchObject({ total: 0, references: [] });
  });

  it("bounds all references while making unknown owners explicit", () => {
    const instance = new PluginInstance("fixture");
    const releases = Array.from({ length: 70 }, () => instance.retainWork());
    expect(instance.retentionSnapshot({ limit: Infinity })).toMatchObject({
      total: 70,
      omitted: 6,
    });
    expect(instance.retentionSnapshot().references).toHaveLength(64);
    expect(instance.retentionSnapshot({ limit: Number.NaN }).references).toHaveLength(64);
    expect(instance.retentionSnapshot({ limit: 0.5 }).references).toHaveLength(0);
    expect(instance.retentionSnapshot().references[0]).toMatchObject({
      owner: "unknown",
      reason: "unknown",
    });
    expect(instance.retentionSnapshot({ limit: -1 })).toMatchObject({
      total: 70,
      omitted: 70,
      references: [],
    });
    releases.forEach((release) => release());
  });

  it("attributes derived consumers without treating idle custody as draining work", async () => {
    const instance = new PluginInstance("fixture");
    const parent = withPluginRetentionOwner({ sessionKey: "parent-session" }, () =>
      instance.retainConsumer(),
    );
    const parentId = instance.retentionSnapshot().references[0]!.referenceId;
    const child = parent.run(() => instance.retainConsumer());
    const custody = instance.retainConsumer(undefined, undefined, "custody");
    expect(instance.retentionSnapshot().references[1]).toMatchObject({
      parentReferenceId: parentId,
      owner: { sessionKey: "parent-session" },
    });
    expect(instance.retainedWorkCount).toBe(2);
    parent.release();
    child.release();
    await instance.waitForRetainedWork(new AbortController().signal);
    expect(instance.retentionSnapshot().references).toMatchObject([{ kind: "custody" }]);
    custody.release();
  });

  it("reports pending consumer teardown until physical completion", async () => {
    const instance = new PluginInstance("fixture");
    const consumer = instance.retainConsumer();
    const gate = createDeferredCore();
    const cleanup = consumer.close(() => gate.promise);
    expect(instance.retentionSnapshot().references).toMatchObject([
      { kind: "consumer", cleanupState: "pending" },
      { kind: "cleanup", cleanupState: "pending" },
    ]);
    consumer.release();
    expect(instance.retainedWorkCount).toBe(1);
    gate.resolve();
    await cleanup;
    expect(instance.retentionSnapshot().total).toBe(0);
  });

  it("keeps failed host cleanup attributed without releasing the drain barrier", async () => {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "fixture", status: "loaded" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    const release = withPluginRetentionOwner({ runId: "cleanup-run" }, () =>
      retainRuntimePluginWork([registry], "prepared-construction"),
    );
    const gate = createDeferredCore();
    const cleanup = releaseRuntimePluginWork(() => gate.promise, release);
    const failure = new PluginRuntimeCloseRetainedError(new Error("private cleanup message"));
    expect(instance.retentionSnapshot().references[0]).toMatchObject({ cleanupState: "pending" });
    gate.reject(failure);
    await expect(cleanup).rejects.toBe(failure);
    expect(instance.retentionSnapshot().references[0]).toMatchObject({
      cleanupState: "failed",
      owner: { runId: "cleanup-run" },
    });
    expect(JSON.stringify(instance.retentionSnapshot())).not.toContain("private cleanup message");
    const abort = new AbortController();
    abort.abort(new Error("observation cancelled"));
    await expect(instance.waitForRetainedWork(abort.signal)).rejects.toThrow(
      "observation cancelled",
    );
    expect(instance.retainedWorkCount).toBe(1);
    release();
    await instance.waitForRetainedWork(new AbortController().signal);
  });

  it("preserves attribution through runtime frames and never changes replacement admission", async () => {
    const instance = new PluginInstance("fixture");
    const gate = createDeferredCore();
    const run = withPluginRetentionOwner({ runId: "active-run" }, () =>
      withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
        instance.run(() => gate.promise),
      ),
    );
    expect(instance.retentionSnapshot().references[0]).toMatchObject({
      kind: "call",
      owner: { runId: "active-run" },
    });
    const release = instance.reserveReplacement();
    expect(instance.retentionSnapshot().replacementPending).toBe(true);
    expect(() => instance.retainWork()).toThrow("replacement is in progress");
    gate.resolve();
    await run;
    release();
    expect(instance.retentionSnapshot().total).toBe(0);
  });
});
