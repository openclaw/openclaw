import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import * as loader from "../../plugins/loader.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { createMigrationResourceFixture } from "../../plugins/migration-provider.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { migrationsHandlers } from "./migrations.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});

type Fixture = ReturnType<typeof createMigrationResourceFixture>;
async function withFixture(fixture: Fixture, run: () => Promise<void>) {
  using _ = { [Symbol.dispose]: () => fixture.cleanup() };
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
    },
    run,
  );
}

function requests(fixture: Fixture, extra: Partial<GatewayRequestContext> = {}) {
  const context = {
    getRuntimeConfig: () => fixture.config,
    dedupe: new Map(),
    ...extra,
  } as GatewayRequestContext;
  return (method: keyof typeof migrationsHandlers, params: Record<string, unknown>) => {
    const handler = expectDefined(migrationsHandlers[method], method);
    const frames: string[] = [];
    const respond = vi.fn<RespondFn>((ok, payload, error, meta) => {
      frames.push(JSON.stringify({ ok, payload, error, meta }));
    });
    return {
      respond,
      frames,
      run: () =>
        handler({
          params,
          respond,
          context,
          client: null,
          req: { type: "req", id: "migration-resource-test", method },
          isWebchatConnect: () => false,
        }),
    };
  };
}

function expectConnections(fixture: Fixture, ...states: [boolean, number][]) {
  expect(
    fixture.state.connections.map(({ database, disposals }) => [database.isOpen, disposals]),
  ).toEqual(states);
}

async function applyParams(invoke: ReturnType<typeof requests>, providerId: string, key: string) {
  const plan = invoke("migrations.memory.plan", { agentId: "main" });
  await plan.run();
  expect(plan.frames).toHaveLength(1);
  const preview = JSON.parse(plan.frames[0] ?? "{}");
  expect(preview.ok).toBe(true);
  const fingerprint: unknown = preview.payload.providers[0]?.planFingerprint;
  expect(fingerprint).toEqual(expect.any(String));
  return {
    agentId: "main",
    providerId,
    itemIds: ["memory:one"],
    idempotencyKey: key,
    planFingerprint: fingerprint,
  };
}

it.each(["success", "cleanup failure", "encoding failure"] as const)(
  "replays a terminal %s after native resources close without applying again",
  async (mode) => {
    const fixture = createMigrationResourceFixture();
    const logGateway = createSubsystemLogger("migration-native-test");
    const warn = vi.spyOn(logGateway, "warn").mockImplementation(() => {});
    const invoke = requests(fixture, { logGateway });
    await withFixture(fixture, async () => {
      const params = await applyParams(invoke, fixture.id, "native-memory-import");
      expectConnections(fixture, [false, 1]);
      fixture.state.failCleanup = mode === "cleanup failure";
      fixture.state.failEncoding = mode === "encoding failure";
      const first = invoke("migrations.memory.apply", params);
      const firstRun = first.run();
      try {
        await Promise.race([fixture.state.applying.promise, firstRun]);
        expect(fixture.state.applyCalls).toBe(1);
        expect(fixture.state.connections[1]?.database.isOpen, first.frames.join("\n")).toBe(true);
        const retry = invoke("migrations.memory.apply", params);
        const retryRun = retry.run();
        await Promise.resolve();
        expect(retry.respond).not.toHaveBeenCalled();
        fixture.state.resumeApply.resolve();
        await Promise.all([firstRun, retryRun]);
        expect([first.frames.length, retry.frames.length]).toEqual([1, 1]);
        const initial = JSON.parse(first.frames[0] ?? "{}");
        const joined = JSON.parse(retry.frames[0] ?? "{}");
        expect(joined).toEqual({ ...initial, meta: { cached: true } });
        expect(initial.ok).toBe(mode !== "encoding failure");
        if (mode === "encoding failure") {
          expect(initial.error.message).toContain(
            "apply completed, but its result could not be returned",
          );
        } else {
          expect(initial.payload.items[0].details).toEqual({ value: 42 });
        }
        expectConnections(fixture, [false, 1], [false, 1]);
        const reads = fixture.state.jsonReads;
        expect(reads).toBeGreaterThan(0);
        const later = invoke("migrations.memory.apply", params);
        await later.run();
        expect(later.frames).toEqual(retry.frames);
        expect(fixture.state.jsonReads).toBe(reads);
        expect(fixture.state.applyCalls).toBe(1);
        expect(warn.mock.calls.length).toBe(mode === "cleanup failure" ? 1 : 0);
        using readback = new DatabaseSync(path.join(fixture.root, "source.sqlite"));
        expect(readback.prepare("SELECT count(*) AS count FROM imports").get()).toEqual({
          count: 1,
        });
      } finally {
        fixture.state.resumeApply.resolve();
        await firstRun;
      }
    });
  },
);

it("joins fresh planning before releasing its database when a raw active provider getter rejects", async () => {
  const active = createMigrationResourceFixture();
  using _ = { [Symbol.dispose]: () => active.cleanup() };
  const fresh = createMigrationResourceFixture({ pausePlan: true });
  const plan = requests(fresh)("migrations.memory.plan", { agentId: "main" });
  await withFixture(fresh, async () => {
    const raw = await loadAndActivateRootPluginRegistry({ config: active.config });
    expect(raw.migrationProviders).toHaveLength(1);
    active.state.failLabel = true;
    fresh.state.failPlan = true;
    let settled = false;
    const request = plan.run();
    const completion = Promise.resolve(request)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await Promise.race([fresh.state.planning.promise, completion]);
      // Let already-issued promise reactions run without unblocking the native plan.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(fresh.state.planCalls).toBe(1);
      expectConnections(fresh, [true, 0]);
      expect(settled).toBe(false);
      fresh.state.resumePlan.resolve();
      expect(await completion).toBe(active.state.labelError);
      await fresh.state.planFinished.promise;
      expect(plan.respond).not.toHaveBeenCalled();
      expectConnections(fresh, [false, 1]);
      expect(active.state.connections[0]?.database.prepare("SELECT 42 AS value").get()).toEqual({
        value: 42,
      });
      expect(active.state.connections[0]?.disposals).toBe(0);
    } finally {
      fresh.state.resumePlan.resolve();
      await completion;
      await fresh.state.planFinished.promise;
    }
  });
});

it("reserves same-key requests before a real cold acquisition resolves", async () => {
  const fixture = createMigrationResourceFixture();
  const acquired = createDeferredCore();
  const releaseAcquisition = createDeferredCore();
  const invoke = requests(fixture);
  await withFixture(fixture, async () => {
    const params = await applyParams(invoke, fixture.id, "pending-acquisition");
    const acquire = loader.acquirePluginRegistryForInspection;
    const spy = vi
      .spyOn(loader, "acquirePluginRegistryForInspection")
      .mockImplementationOnce(async (options) => {
        const handle = await acquire(options);
        acquired.resolve();
        await releaseAcquisition.promise;
        return handle;
      });
    fixture.state.resumeApply.resolve();
    const first = invoke("migrations.memory.apply", params);
    const firstRun = Promise.resolve(first.run());
    const runs = [firstRun];
    try {
      await Promise.race([acquired.promise, firstRun]);
      expectConnections(fixture, [false, 1], [true, 0]);
      const duplicate = invoke("migrations.memory.apply", params);
      runs.push(Promise.resolve(duplicate.run()));
      const mismatch = invoke("migrations.memory.apply", {
        ...params,
        itemIds: ["memory:other"],
      });
      await mismatch.run();
      expect(mismatch.respond.mock.calls[0]?.[2]?.message).toContain("idempotency key was reused");
      expect([first.respond.mock.calls, duplicate.respond.mock.calls]).toEqual([[], []]);
      expect(fixture.state.applyCalls).toBe(0);
      expect(spy).toHaveBeenCalledOnce();
      releaseAcquisition.resolve();
      await Promise.all(runs);
      expect(first.respond.mock.calls[0]?.[0], first.frames.join("\n")).toBe(true);
      expect(duplicate.respond.mock.calls[0]?.[3]).toEqual({ cached: true });
      expect(fixture.state.applyCalls).toBe(1);
      expect(fixture.state.connections[1]?.disposals).toBe(1);
    } finally {
      releaseAcquisition.resolve();
      await Promise.allSettled(runs);
      spy.mockRestore();
    }
  });
});
