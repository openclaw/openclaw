import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { resolveStateDir } from "../config/paths.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as mutationAdmission from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawConfig, OpenClawPluginToolContext } from "../plugin-sdk/plugin-entry.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { markPluginRegistryActive, revokePluginRecord } from "../plugins/registry-lifecycle.js";
import type { PluginRecord } from "../plugins/registry-types.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  startPluginServices,
  type PluginServicesHandle,
} from "../plugins/services.test-support.js";
import { createPluginRecord as pluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetPluginBlobStoreForTests } from "./plugin-blob-store.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";

describe("plugin-state-store.authority", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
  });

  describe("action-bound plugin state", () => {
    it("refuses a continuous Visitor renewal whose original grant expires before native commit", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await withOpenClawTestState(
          {
            label: "visitor-renewal-deadline",
            env: {
              OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(
                new URL("../../extensions/", import.meta.url),
              ),
              OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            },
          },
          async (state) => {
            const email = "visitor@example.test";
            const previous = {
              grantId: randomUUID(),
              email,
              createdAt: Date.now(),
              expiresAt: Date.now() + 1_000,
            };
            const store = createPluginStateKeyedStore<typeof previous>("visitor-access", {
              namespace: "visitor-grants",
              maxEntries: 500,
              overflowPolicy: "reject-new",
              env: state.env,
            });
            await store.register(email, previous);
            const config: OpenClawConfig = {
              gateway: {
                roles: {
                  default: "guest",
                  definitions: {
                    guest: {
                      accessPolicyPlugin: "visitor-access",
                      sessions: { others: "view" },
                      agents: ["main"],
                      scopes: ["operator.sessions.write"],
                      sandbox: "required",
                      modelPolicy: {},
                    },
                  },
                },
              },
              plugins: {
                allow: ["visitor-access"],
                slots: { memory: "none" },
                entries: {
                  "visitor-access": {
                    enabled: true,
                    config: {
                      accountId: "test",
                      appId: "test",
                      apiToken: "synthetic-visitor-token",
                    },
                  },
                },
              },
            };
            await state.writeConfig(config);
            setRuntimeConfigSnapshot(config);
            const policyUrl =
              "https://api.cloudflare.com/client/v4/accounts/test/access/apps/test/policies";
            const policy = {
              id: "visitors",
              name: "Visitors (openclaw-managed)",
              decision: "allow",
              include: [{ email: { email } }],
            };
            let providerConfirmed = false;
            vi.stubGlobal(
              "fetch",
              async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                const url = new URL(input instanceof Request ? input.url : input);
                expect(init?.method).toBe("GET");
                expect(url.href.startsWith(policyUrl)).toBe(true);
                if (url.pathname.endsWith("/visitors")) {
                  providerConfirmed = true;
                }
                return Response.json({ success: true, result: url.search ? [policy] : policy });
              },
            );
            const toolContext: OpenClawPluginToolContext<2> = {
              senderIsOwner: true,
              assertInvocationCurrent() {},
            };
            const unexpectedSubagent = () => {
              throw new Error("Visitor grant renewal must not dispatch subagent work");
            };
            const gateway: PluginRuntime["gateway"] = {
              isAvailable: async () => true,
              async openPluginPanel() {
                throw new Error("Unexpected plugin panel request");
              },
              async readSessionFacts() {
                throw new Error("Unexpected session facts request");
              },
              async withSessionFacts() {
                throw new Error("Unexpected session read scope");
              },
              subscribeSessionChanges() {
                throw new Error("Unexpected session changes subscription");
              },
              async request() {
                throw new Error("Unexpected Gateway request");
              },
            };
            vi.spyOn(gateway, "request").mockImplementation(async (method) => {
              expect(method).toBe("users.list");
              return { profiles: [] };
            });
            const registry = await loadAndActivateRootPluginRegistry({
              config,
              env: state.env,
              workspaceDir: state.workspaceDir,
              onlyPluginIds: ["visitor-access"],
              preferBuiltPluginArtifacts: true,
              cache: false,
              runtimeOptions: {
                gateway,
                // Service node setup probes this host binding even when the service never invokes nodes.
                subagent: {
                  complete: unexpectedSubagent,
                  run: unexpectedSubagent,
                  waitForRun: unexpectedSubagent,
                  getSessionMessages: unexpectedSubagent,
                  deleteSession: unexpectedSubagent,
                },
              },
            });
            let services: PluginServicesHandle | undefined;
            try {
              const loaded = registry.plugins.find(({ id }) => id === "visitor-access");
              expect(loaded, loaded?.error).toMatchObject({
                origin: "bundled",
                status: "loaded",
              });
              await startPluginServices({
                registry,
                config,
                workspaceDir: state.workspaceDir,
                throwOnStartError: true,
                onHandle: (handle) => {
                  services = handle;
                },
              });
              const registration = registry.tools.find(
                ({ pluginId, names }) =>
                  pluginId === "visitor-access" && names.includes("visitor_invite"),
              );
              if (!registration || registration.contextVersion !== 2) {
                throw new Error(
                  "Visitor Access did not register its invitation tool with action authority",
                );
              }
              const created = registration.factory(toolContext);
              const invite = Array.isArray(created)
                ? created.find(({ name }) => name === "visitor_invite")
                : created;
              if (!invite || invite.name !== "visitor_invite") {
                throw new Error("Visitor Access did not create its invitation tool");
              }
              providerConfirmed = false;
              const posting = vi.spyOn(Worker.prototype, "postMessage");
              const submittedRenewals = () => {
                const submitted: unknown[] = [];
                for (const [message] of posting.mock.calls) {
                  const request = asOptionalRecord(message);
                  if (request?.type === "execute" && request.input instanceof Uint8Array) {
                    const operation = asOptionalRecord(deserialize(request.input));
                    const input = asOptionalRecord(operation?.input);
                    if (
                      operation?.type === "pluginState.register" &&
                      input?.pluginId === "visitor-access" &&
                      input.namespace === "visitor-grants"
                    ) {
                      expect(providerConfirmed).toBe(true);
                      expect(input.key).toBe(email);
                      if (typeof input.valueJson !== "string") {
                        throw new Error("Expected the native visitor grant submission");
                      }
                      submitted.push(JSON.parse(input.valueJson));
                    }
                  }
                }
                return submitted;
              };
              let heldCommit = false;
              const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
              const admission = vi
                .spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission")
                .mockImplementation((admit, attachment) =>
                  createAdmission((request, grant) => {
                    if (
                      request.stage === "commit" &&
                      !heldCommit &&
                      submittedRenewals().length > 0
                    ) {
                      heldCommit = true;
                      // The native transaction already wrote its candidate; only its real commit guard remains.
                      vi.setSystemTime(previous.expiresAt + 1);
                    }
                    admit(request, grant);
                  }, attachment),
                );
              try {
                const renewal = await invite.execute("renew", { email, days: 2 });
                expect(heldCommit).toBe(true);
                expect(submittedRenewals()).toEqual([
                  { ...previous, expiresAt: previous.createdAt + 2 * 86_400_000 },
                ]);
                expect(renewal).toMatchObject({ isError: true, details: { error: true } });
                expect(await store.lookup(email)).toEqual(previous);
              } finally {
                admission.mockRestore();
                posting.mockRestore();
              }

              await expect(invite.execute("reinvite", { email, days: 2 })).resolves.toMatchObject({
                details: {},
              });
              const reissued = await store.lookup(email);
              expect(reissued?.grantId).toEqual(expect.any(String));
              expect(reissued?.grantId).not.toBe(previous.grantId);
              expect(reissued?.expiresAt).toBe(previous.expiresAt + 1 + 2 * 86_400_000);
            } finally {
              try {
                const stopped = await services?.stop({ strict: true });
                if (stopped) {
                  expect(stopped.errors).toEqual([]);
                }
              } finally {
                await clearActivePluginRegistry(registry);
              }
            }
          },
        );
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    });

    it.each([
      ["manager", "dispatch", "register"],
      ["manager", "transaction", "register"],
      ["manager", "commit", "register"],
      ["manager", "after commit", "register"],
      ["plugin", "commit", "delete"],
    ] as const)(
      "preserves %s authority settlement at %s for %s",
      async (authority, revocation, operation) => {
        await withOpenClawTestState({ label: "plugin-state-renewal-authority" }, async (state) => {
          let current = true;
          const assertInvocationCurrent = vi.fn(() => {
            if (!current) {
              throw new Error(`Synthetic ${authority} authority closed`);
            }
          });
          const store = createPluginStateKeyedStore<{ expiresAt: number }>(
            "visitor-access",
            {
              namespace: "visitors",
              maxEntries: 10,
              overflowPolicy: "reject-new",
              env: state.env,
            },
            authority === "plugin" ? assertInvocationCurrent : undefined,
          );
          const email = "visitor@example.test";
          const previous = { expiresAt: Date.now() + 60_000 };
          const renewed = { expiresAt: previous.expiresAt + 60_000 };
          const action = store.withCurrent({
            assertCurrent: authority === "manager" ? assertInvocationCurrent : () => {},
          });
          await (authority === "plugin" ? action : store).register(email, previous);
          const stages: string[] = [];
          const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
          vi.spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
            (admit, attachment) =>
              createAdmission((request, grant) => {
                stages.push(request.stage);
                if (request.stage === revocation) {
                  current = false;
                }
                admit(request, grant);
                if (request.stage === "commit" && revocation === "after commit") {
                  current = false;
                }
              }, attachment),
          );
          if (revocation === "dispatch") {
            const postMessageSpy = vi.spyOn(Worker.prototype, "postMessage");
            postMessageSpy.mockImplementationOnce(function (this: Worker, message, transferList) {
              const request = asOptionalRecord(message);
              if (
                request?.type === "execute" &&
                request.input instanceof Uint8Array &&
                asOptionalRecord(deserialize(request.input))?.type === "pluginState.register"
              ) {
                // The caller passed its pre-dispatch check; the write is now queued for SQLite.
                current = false;
              }
              postMessageSpy.mockRestore();
              return this.postMessage(message, transferList);
            });
          }

          const writing =
            operation === "delete" ? action.delete(email) : action.register(email, renewed);
          if (revocation === "after commit") {
            await expect(writing).resolves.toBeUndefined();
          } else {
            await expect(writing).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
          }
          expect(current).toBe(false);
          expect(assertInvocationCurrent).toHaveBeenCalled();
          if (revocation !== "dispatch") {
            expect(stages).toEqual(
              revocation === "transaction" ? ["transaction"] : ["transaction", "commit"],
            );
          }
          expect(await store.lookup(email)).toEqual(
            revocation === "after commit" ? renewed : previous,
          );
        });
      },
    );

    it.each(["observe", "update conflict", "delete conflict"] as const)(
      "withholds a %s observation when authority closes after transaction admission",
      async (operation) => {
        await withOpenClawTestState(
          { label: "plugin-state-observation-authority" },
          async (state) => {
            const store = createPluginStateKeyedStore<string>("private-records", {
              namespace: "observations",
              maxEntries: 10,
              env: state.env,
            });
            await store.register("key", "before");
            const observed = await store.observe("key");
            await store.register("key", "private current value");
            let current = true;
            const action = store.withCurrent({
              assertCurrent: () => {
                if (!current) {
                  throw new Error("Synthetic reader authority closed");
                }
              },
            });
            const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
            vi.spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
              (admit, attachment) =>
                createAdmission((request, grant) => {
                  admit(request, grant);
                  if (request.stage === "commit") {
                    current = false;
                  }
                }, attachment),
            );
            const reading =
              operation === "observe"
                ? action.observe("key")
                : action.compareAndApply("key", observed.comparison, {
                    operation: operation === "update conflict" ? "update" : "delete",
                    action: "keep",
                  });
            await expect(reading).rejects.toThrow();
            expect(current).toBe(false);
            expect(await store.lookup("key")).toBe("private current value");
          },
        );
      },
    );
  });
});

describe("plugin-state-store.runtime", () => {
  function createPluginRecord(
    id: string,
    origin: PluginRecord["origin"] = "bundled",
    opts: { trustedOfficialInstall?: boolean } = {},
  ): PluginRecord {
    return pluginRecord({ id, source: `/plugins/${id}/index.ts`, origin, ...opts });
  }

  function setup(record: PluginRecord, active = false) {
    const registry = createPluginRegistry({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {
        state: {
          resolveStateDir,
          openBlobStore: () => {
            throw new Error("registry plugin runtime proxy should bind openBlobStore");
          },
          openKeyedStore: () => {
            throw new Error("registry plugin runtime proxy should bind openKeyedStore");
          },
          openSyncKeyedStore: () => {
            throw new Error("registry plugin runtime proxy should bind openSyncKeyedStore");
          },
        },
      } as unknown as PluginRuntime,
    });
    registry.registry.plugins.push(record);
    if (active) {
      markPluginRegistryActive(registry.registry);
    }
    return { registry, runtime: registry.createApi(record, { config: {} }).runtime.state };
  }

  const keyedOptions = { namespace: "runtime", maxEntries: 10 };
  const blobOptions = { ...keyedOptions, maxBytesPerEntry: 1024, maxBytesPerNamespace: 4096 };

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    resetPluginBlobStoreForTests();
    resetPluginStateStoreForTests();
  });

  describe("plugin runtime state proxy", () => {
    it("binds keyed stores to local plugin ids and keeps resolveStateDir", async () => {
      await withOpenClawTestState({ label: "plugin-state-runtime" }, async (state) => {
        const record = createPluginRecord("discord", "config");
        const { registry, runtime } = setup(record);

        expect(runtime.resolveStateDir()).toBe(state.stateDir);
        const observation = observeHostDataSql();
        const sql = observation.calls;
        try {
          const store = runtime.openKeyedStore<{ plugin: string }>(keyedOptions);
          await expect(store.registerIfAbsent("k", { plugin: "discord" })).resolves.toBe(true);
          await expect(store.registerIfAbsent("k", { plugin: "duplicate" })).resolves.toBe(false);

          const telegram = createPluginRecord("telegram", "workspace");
          registry.registry.plugins.push(telegram);
          const telegramApi = registry.createApi(telegram, { config: {} });
          const telegramStore = telegramApi.runtime.state.openKeyedStore<{ plugin: string }>(
            keyedOptions,
          );
          await expect(telegramStore.lookup("k")).resolves.toBeUndefined();
          await expect(telegramStore.count?.()).resolves.toBe(0);
          await expect(store.count?.()).resolves.toBe(1);
          await expect(store.lookup("k")).resolves.toEqual({ plugin: "discord" });

          await store.register("temporary", { plugin: "discord" });
          await expect(store.consume("temporary")).resolves.toEqual({ plugin: "discord" });
          await store.register("deleted", { plugin: "discord" });
          await expect(store.delete("deleted")).resolves.toBe(true);
          await telegramStore.register("retained", { plugin: "telegram" });
          await store.clear();
          await expect(store.entries()).resolves.toEqual([]);
          await expect(telegramStore.lookup("retained")).resolves.toEqual({ plugin: "telegram" });
          for (const method of sql) {
            expect(method).not.toHaveBeenCalled();
          }
        } finally {
          observation.restore();
        }

        const syncStore = runtime.openSyncKeyedStore<{ plugin: string }>({
          namespace: "sync-runtime",
          maxEntries: 10,
        });
        expect(syncStore.registerIfAbsent("k", { plugin: "discord" })).toBe(true);
        expect(syncStore.lookup("k")).toEqual({ plugin: "discord" });
      });
    });

    it("fences retained operations and range reads when the owning plugin closes", async () => {
      await withOpenClawTestState({ label: "plugin-retained-runtime-closure" }, async () => {
        const record = createPluginRecord("history-owner", "config");
        const { registry, runtime } = setup(record, true);
        const sourceOptions = { namespace: "history", maxEntries: 10 };
        const retainedOptions = { namespace: "history", retention: "retained" as const };
        const source = runtime.openKeyedStore<number>(sourceOptions);
        const retained = runtime.openKeyedStore<number>(retainedOptions);
        await source.register("legacy", 1);
        await retained.register("current", 2);
        const observed = await retained.observe!("current");
        const range = { keyStartInclusive: "a", keyEndExclusive: "z", limit: 10 };
        const detachedRead = retained.entriesInKeyRange!;
        const pendingMove = retained.moveEntriesFrom!({
          namespace: "history",
          entries: [{ sourceKey: "legacy", targetKey: "promoted" }],
        });
        revokePluginRecord(registry.registry, record);
        await expect(pendingMove).rejects.toThrow();
        for (const operation of [
          () => retained.register("denied", 3),
          () => retained.registerIfAbsent("denied", 3),
          () => retained.observe!("current"),
          () =>
            retained.compareAndApply!("current", observed.comparison, {
              operation: "update",
              action: "set",
              value: 3,
            }),
          () => retained.update!("current", () => 3),
          () => retained.deleteIf!("current", () => true),
          () => retained.deleteIfEqual!("current", 2),
          () => retained.lookup("current"),
          () => retained.lookupMany!(["current"]),
          () => retained.consume("current"),
          () => retained.delete("current"),
          () => retained.entries(),
          () => retained.count!(),
          () => retained.clear(),
          () => detachedRead(range),
          () => source.entriesInKeyRange!(range),
        ]) {
          await expect(operation()).rejects.toThrow();
        }
        expect(() => runtime.openKeyedStore(retainedOptions)).toThrow();
        const canonicalSource = createPluginStateKeyedStore<number>(record.id, sourceOptions);
        const canonicalRetained = createPluginStateKeyedStore<number>(record.id, retainedOptions);
        expect(await canonicalSource.lookup("legacy")).toBe(1);
        expect(await canonicalRetained.lookup("current")).toBe(2);
        expect(await canonicalRetained.lookup("promoted")).toBeUndefined();
        expect(await canonicalRetained.lookup("denied")).toBeUndefined();
      });
    });

    it("fences revoked ingress reads, admission, and recovery", async () => {
      await withOpenClawTestState({ label: "plugin-ingress-runtime-closure" }, async (state) => {
        const record = createPluginRecord("ingress-owner", "config");
        const { registry, runtime } = setup(record, true);
        const queue = runtime.openChannelIngressQueue<{ text: string }>({
          now: () => 10,
        });
        await queue.enqueue("claimed", { text: "retained" });
        const claimed = await queue.claim("claimed", { ownerId: "previous" });
        expect(claimed).not.toBeNull();
        const entered = createDeferredCore();
        const releasePolicy = createDeferredCore<boolean>();
        const recovering = queue.recoverStaleClaims({
          now: 20,
          staleMs: 5,
          shouldRecover: () => {
            entered.resolve();
            return releasePolicy.promise;
          },
        });
        try {
          await entered.promise;
          const listing = queue.listClaims();
          const admission = queue.enqueue("denied", { text: "revoked" });
          revokePluginRecord(registry.registry, record);
          releasePolicy.resolve(false);
          await Promise.all([
            expect(recovering).rejects.toThrow(
              'Plugin "ingress-owner" runtime is no longer active',
            ),
            expect(listing).rejects.toThrow('Plugin "ingress-owner" runtime is no longer active'),
            expect(admission).rejects.toThrow('Plugin "ingress-owner" runtime is no longer active'),
          ]);
          const maintenance = createChannelIngressQueue({
            channelId: record.id,
            stateDir: state.stateDir,
          });
          expect(await maintenance.listClaims()).toEqual([claimed]);
          expect(await maintenance.listPending()).toEqual([]);
        } finally {
          releasePolicy.resolve(false);
          await recovering.catch(() => {});
        }
      });
    });

    it.each(
      (["enqueue", "recovery"] as const).flatMap((operation) =>
        (["before", "after"] as const).map((revocation) => ({ operation, revocation })),
      ),
    )(
      "settles ingress $operation when its owner is revoked $revocation the commit grant",
      async ({ operation, revocation }) => {
        await withOpenClawTestState({ label: "plugin-ingress-commit-authority" }, async (state) => {
          const record = createPluginRecord("ingress-owner");
          const { registry, runtime } = setup(record, true);
          const queue = runtime.openChannelIngressQueue<{ text: string }>({
            now: () => 10,
          });
          await queue.enqueue("retained", { text: "retained" });
          const claimed = await queue.claim("retained", { ownerId: "previous" });
          expect(claimed).not.toBeNull();
          const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
          const stages: string[] = [];
          const admission = vi
            .spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission")
            .mockImplementation((admit, attachment) =>
              createAdmission((request, grant) => {
                stages.push(request.stage);
                if (request.stage === "commit" && revocation === "before") {
                  revokePluginRecord(registry.registry, record);
                }
                admit(request, grant);
                if (request.stage === "commit" && revocation === "after") {
                  revokePluginRecord(registry.registry, record);
                }
              }, attachment),
            );
          try {
            const writing =
              operation === "enqueue"
                ? queue.enqueue("admitted", { text: "new event" })
                : queue.recoverStaleClaims({ now: 20, staleMs: 5 });
            if (revocation === "before") {
              await expect(writing).rejects.toThrow(
                'Plugin "ingress-owner" runtime is no longer active',
              );
            } else if (operation === "enqueue") {
              await expect(writing).resolves.toMatchObject({
                kind: "accepted",
                duplicate: false,
                record: { id: "admitted" },
              });
            } else {
              await expect(writing).resolves.toBe(1);
            }
            expect(stages).toEqual(["transaction", "commit"]);
            const inspector = createChannelIngressQueue({
              channelId: record.id,
              stateDir: state.stateDir,
              access: "read-only",
            });
            expect((await inspector.listPending()).map((row) => row.id)).toEqual(
              revocation === "before" ? [] : [operation === "enqueue" ? "admitted" : "retained"],
            );
            expect(await inspector.listClaims()).toEqual(
              operation === "recovery" && revocation === "after" ? [] : [claimed],
            );
          } finally {
            admission.mockRestore();
          }
        });
      },
    );

    it("binds blob stores to untrusted plugin ids", async () => {
      await withOpenClawTestState({ label: "plugin-blob-runtime" }, async () => {
        const record = createPluginRecord("diffs", "global");
        const { registry, runtime } = setup(record);

        const store = runtime.openBlobStore<{ kind: string }>(blobOptions);
        await expect(
          store.registerIfAbsent("viewer", new Uint8Array([1, 2, 3]), { kind: "viewer" }),
        ).resolves.toBe(true);
        await expect(store.lookup("viewer")).resolves.toMatchObject({
          key: "viewer",
          metadata: { kind: "viewer" },
          sizeBytes: 3,
        });

        const otherRecord = createPluginRecord("other", "bundled");
        registry.registry.plugins.push(otherRecord);
        const otherStore = registry
          .createApi(otherRecord, { config: {} })
          .runtime.state.openBlobStore<{ kind: string }>(blobOptions);
        await expect(otherStore.lookup("viewer")).resolves.toBeUndefined();
      });
    });

    it("ignores plugin-supplied state directory overrides", async () => {
      await withOpenClawTestState({ label: "plugin-blob-runtime-env" }, async (state) => {
        const record = createPluginRecord("diffs", "global", { trustedOfficialInstall: true });
        const { runtime } = setup(record);
        const redirectedEnv = {
          ...state.env,
          OPENCLAW_STATE_DIR: `${state.stateDir}-redirected`,
        };

        const options = { ...blobOptions, namespace: "runtime-env", env: redirectedEnv };
        const store = runtime.openBlobStore<{ kind: string }>(options);
        await store.register("viewer", new Uint8Array([1]), { kind: "viewer" });

        await closeOpenClawStateDatabaseAsync();
        resetPluginBlobStoreForTests();
        const { db } = openOpenClawStateDatabase({ env: state.env });
        expect(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM plugin_blob_entries
             WHERE plugin_id = ? AND namespace = ? AND entry_key = ?`,
            )
            .get("diffs", "runtime-env", "viewer"),
        ).toEqual({ count: 1 });
      });
    });
  });
});
