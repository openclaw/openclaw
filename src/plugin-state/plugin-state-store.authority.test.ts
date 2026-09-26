import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as mutationAdmission from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawConfig, OpenClawPluginToolContext } from "../plugin-sdk/plugin-entry.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginStateKeyedStore } from "./plugin-state-store.js";

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
                  config: { accountId: "test", appId: "test", apiToken: "synthetic-visitor-token" },
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
          vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : input);
            expect(init?.method).toBe("GET");
            expect(url.href.startsWith(policyUrl)).toBe(true);
            if (url.pathname.endsWith("/visitors")) {
              providerConfirmed = true;
            }
            return Response.json({ success: true, result: url.search ? [policy] : policy });
          });
          const toolContext: OpenClawPluginToolContext<2> = {
            senderIsOwner: true,
            assertInvocationCurrent() {},
          };
          const unexpectedSubagent = () => {
            throw new Error("Visitor grant renewal must not dispatch subagent work");
          };
          const gateway: PluginRuntime["gateway"] = {
            isAvailable: async () => true,
            async request() {
              throw new Error("Unexpected Gateway request");
            },
          };
          vi.spyOn(gateway, "request").mockImplementation(async (method) => {
            expect(method).toBe("users.list");
            return { profiles: [] };
          });
          const registry = loadAndActivateRootPluginRegistry({
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
                  if (request.stage === "commit" && !heldCommit && submittedRenewals().length > 0) {
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

  it.each(["dispatch", "transaction", "commit", "after commit"] as const)(
    "preserves renewal settlement when manager authority closes at %s",
    async (revocation) => {
      await withOpenClawTestState({ label: "plugin-state-renewal-authority" }, async (state) => {
        const store = createPluginStateKeyedStore<{ expiresAt: number }>("visitor-access", {
          namespace: "visitors",
          maxEntries: 10,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const email = "visitor@example.test";
        const previous = { expiresAt: Date.now() + 60_000 };
        const renewed = { expiresAt: previous.expiresAt + 60_000 };
        await store.register(email, previous);
        let managerCurrent = true;
        const assertInvocationCurrent = vi.fn();
        const action = store.withCurrent({
          assertCurrent: () => {
            assertInvocationCurrent();
            if (!managerCurrent) {
              throw new Error("Synthetic manager authority closed");
            }
          },
        });
        const stages: string[] = [];
        const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
        vi.spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (admit, attachment) =>
            createAdmission((request, grant) => {
              stages.push(request.stage);
              if (request.stage === revocation) {
                managerCurrent = false;
              }
              admit(request, grant);
              if (request.stage === "commit" && revocation === "after commit") {
                managerCurrent = false;
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
              managerCurrent = false;
            }
            postMessageSpy.mockRestore();
            return this.postMessage(message, transferList);
          });
        }

        const writing = action.register(email, renewed);
        if (revocation === "after commit") {
          await expect(writing).resolves.toBeUndefined();
        } else {
          await expect(writing).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
        }
        expect(managerCurrent).toBe(false);
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

  it("keeps a bounded action view tied to its original plugin lifetime", async () => {
    await withOpenClawTestState({ label: "plugin-state-action-lifetime" }, async (state) => {
      let runtimeCurrent = true;
      const store = createPluginStateKeyedStore<string>(
        "visitor-access",
        {
          namespace: "visitors",
          maxEntries: 10,
          overflowPolicy: "reject-new",
          env: state.env,
        },
        () => {
          if (!runtimeCurrent) {
            throw new Error("Synthetic plugin lifetime closed");
          }
        },
      );
      const action = store.withCurrent({ assertCurrent: () => {} });
      await action.register("visitor@example.test", "original");
      const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
      vi.spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (admit, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit") {
              runtimeCurrent = false;
            }
            admit(request, grant);
          }, attachment),
      );
      await expect(action.delete("visitor@example.test")).rejects.toMatchObject({
        code: "PLUGIN_STATE_WRITE_FAILED",
      });
      expect(await store.lookup("visitor@example.test")).toBe("original");
    });
  });
});
