import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});

describe("memory migration registration resources", () => {
  it.each(["success", "cleanup failure", "encoding failure"] as const)(
    "replays a terminal %s after native resources close without applying again",
    async (mode) => {
      const fixture = createMigrationResourceFixture();
      const dedupe: GatewayRequestContext["dedupe"] = new Map();
      const logGateway = createSubsystemLogger("migration-native-test");
      const warn = vi.spyOn(logGateway, "warn").mockImplementation(() => {});
      const context = {
        getRuntimeConfig: () => fixture.config,
        dedupe,
        logGateway,
      } as GatewayRequestContext;
      const invoke = (method: keyof typeof migrationsHandlers, params: Record<string, unknown>) => {
        const frames: string[] = [];
        const respond: RespondFn = (ok, payload, error, meta) => {
          frames.push(JSON.stringify({ ok, payload, error, meta }));
        };
        return {
          frames,
          run: () =>
            expectDefined(
              migrationsHandlers[method],
              method,
            )({
              params,
              respond,
              context,
              client: null,
              req: { type: "req", id: "migration-resource-test", method },
              isWebchatConnect: () => false,
            }),
        };
      };
      try {
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
            OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
          },
          async () => {
            const plan = invoke("migrations.memory.plan", { agentId: "main" });
            await plan.run();
            expect(plan.frames).toHaveLength(1);
            const preview = JSON.parse(plan.frames[0] ?? "{}");
            expect(preview.ok).toBe(true);
            const fingerprint: unknown = preview.payload.providers[0]?.planFingerprint;
            expect(fingerprint).toEqual(expect.any(String));
            expect(fixture.state.connections[0]?.database.isOpen).toBe(false);
            fixture.state.failCleanup = mode === "cleanup failure";
            fixture.state.failEncoding = mode === "encoding failure";
            const params = {
              agentId: "main",
              providerId: fixture.id,
              itemIds: ["memory:one"],
              idempotencyKey: "native-memory-import",
              planFingerprint: fingerprint,
            };
            const first = invoke("migrations.memory.apply", params);
            const firstRun = first.run();
            try {
              await Promise.race([fixture.state.applying.promise, firstRun]);
              expect(fixture.state.applyCalls).toBe(1);
              expect(fixture.state.connections[1]?.database.isOpen).toBe(true);
              const retry = invoke("migrations.memory.apply", params);
              const retryRun = retry.run();
              fixture.state.resumeApply.resolve();
              await Promise.all([firstRun, retryRun]);
              expect(first.frames).toHaveLength(1);
              expect(retry.frames).toHaveLength(1);
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
              expect(fixture.state.connections).toHaveLength(2);
              expect(
                fixture.state.connections.every(
                  ({ database, disposals }) => !database.isOpen && disposals === 1,
                ),
              ).toBe(true);
              const reads = fixture.state.jsonReads;
              expect(reads).toBeGreaterThan(0);
              const later = invoke("migrations.memory.apply", params);
              await later.run();
              expect(later.frames).toEqual(retry.frames);
              expect(fixture.state.jsonReads).toBe(reads);
              expect(fixture.state.applyCalls).toBe(1);
              expect(warn.mock.calls.length).toBe(mode === "cleanup failure" ? 1 : 0);
              const readback = new DatabaseSync(path.join(fixture.root, "source.sqlite"));
              try {
                expect(readback.prepare("SELECT count(*) AS count FROM imports").get()).toEqual({
                  count: 1,
                });
              } finally {
                readback.close();
              }
            } finally {
              fixture.state.resumeApply.resolve();
              await firstRun;
            }
          },
        );
      } finally {
        warn.mockRestore();
        fixture.cleanup();
      }
    },
  );

  it("joins fresh planning before releasing its database when a raw active provider getter rejects", async () => {
    const active = createMigrationResourceFixture();
    const fresh = createMigrationResourceFixture({ pausePlan: true });
    const respond = vi.fn<RespondFn>();
    const context = { getRuntimeConfig: () => fresh.config } as GatewayRequestContext;
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(fresh.root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(fresh.root, "state", "openclaw.json"),
        },
        async () => {
          const raw = loadAndActivateRootPluginRegistry({ config: active.config });
          expect(raw.migrationProviders).toHaveLength(1);
          active.state.failLabel = true;
          fresh.state.failPlan = true;
          let settled = false;
          const request = expectDefined(
            migrationsHandlers["migrations.memory.plan"],
            "memory plan",
          )({
            params: { agentId: "main" },
            respond,
            context,
            client: null,
            req: { type: "req", id: "mixed-owner-plan", method: "migrations.memory.plan" },
            isWebchatConnect: () => false,
          });
          const completion = Promise.resolve(request).then(
            () => {
              settled = true;
              return undefined;
            },
            (error: unknown) => {
              settled = true;
              return error;
            },
          );
          try {
            await Promise.race([fresh.state.planning.promise, completion]);
            // Let already-issued promise reactions run without unblocking the native plan.
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(fresh.state.planCalls).toBe(1);
            expect(fresh.state.connections).toHaveLength(1);
            expect(fresh.state.connections[0]?.database.isOpen).toBe(true);
            expect(settled).toBe(false);
            fresh.state.resumePlan.resolve();
            expect(await completion).toBe(active.state.labelError);
            await fresh.state.planFinished.promise;
            expect(respond).not.toHaveBeenCalled();
            expect(fresh.state.connections[0]?.disposals).toBe(1);
            expect(fresh.state.connections[0]?.database.isOpen).toBe(false);
            expect(
              active.state.connections[0]?.database.prepare("SELECT 42 AS value").get(),
            ).toEqual({ value: 42 });
            expect(active.state.connections[0]?.disposals).toBe(0);
          } finally {
            fresh.state.resumePlan.resolve();
            await completion;
            await fresh.state.planFinished.promise;
          }
        },
      );
    } finally {
      fresh.cleanup();
      active.cleanup();
    }
  });

  it("reserves same-key requests before a real cold acquisition resolves", async () => {
    const fixture = createMigrationResourceFixture();
    const acquired = createDeferredCore();
    const releaseAcquisition = createDeferredCore();
    const dedupe: GatewayRequestContext["dedupe"] = new Map();
    const context = { getRuntimeConfig: () => fixture.config, dedupe } as GatewayRequestContext;
    const invoke = (method: keyof typeof migrationsHandlers, params: Record<string, unknown>) => {
      const frames: string[] = [];
      const respond = vi.fn<RespondFn>((ok, payload, error, meta) => {
        frames.push(JSON.stringify({ ok, payload, error, meta }));
      });
      return {
        respond,
        frames,
        run: () =>
          expectDefined(
            migrationsHandlers[method],
            method,
          )({
            params,
            respond,
            context,
            client: null,
            req: { type: "req", id: "acquisition-reservation", method },
            isWebchatConnect: () => false,
          }),
      };
    };
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(fixture.root, "state", "openclaw.json"),
        },
        async () => {
          const plan = invoke("migrations.memory.plan", { agentId: "main" });
          await plan.run();
          const preview = JSON.parse(plan.frames[0] ?? "{}").payload;
          const params = {
            agentId: "main",
            providerId: fixture.id,
            itemIds: ["memory:one"],
            idempotencyKey: "pending-acquisition",
            planFingerprint: preview.providers[0].planFingerprint,
          };
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
            expect(fixture.state.connections).toHaveLength(2);
            expect(fixture.state.connections[1]?.database.isOpen).toBe(true);
            const duplicate = invoke("migrations.memory.apply", params);
            runs.push(Promise.resolve(duplicate.run()));
            const mismatch = invoke("migrations.memory.apply", {
              ...params,
              itemIds: ["memory:other"],
            });
            await mismatch.run();
            expect(mismatch.respond.mock.calls[0]?.[2]?.message).toContain(
              "idempotency key was reused",
            );
            expect(first.respond).not.toHaveBeenCalled();
            expect(duplicate.respond).not.toHaveBeenCalled();
            expect(fixture.state.applyCalls).toBe(0);
            expect(spy).toHaveBeenCalledOnce();
            releaseAcquisition.resolve();
            await Promise.all(runs);
            expect(first.respond.mock.calls[0]?.[0]).toBe(true);
            expect(duplicate.respond.mock.calls[0]?.[3]).toEqual({ cached: true });
            expect(fixture.state.applyCalls).toBe(1);
            expect(fixture.state.connections[1]?.disposals).toBe(1);
          } finally {
            releaseAcquisition.resolve();
            await Promise.allSettled(runs);
            spy.mockRestore();
          }
        },
      );
    } finally {
      fixture.cleanup();
    }
  });
});
