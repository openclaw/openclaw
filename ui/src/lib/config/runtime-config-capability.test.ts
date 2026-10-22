// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createGatewayHarness,
  createConfigServerMock,
  createConfigCapabilityHarness,
} from "./config-test-harness.ts";
import {
  loadHarness,
  makeSnapshot,
  mockRequest,
  pendingAutoSave,
} from "./config-write.test-support.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("runtime config capability", () => {
  it("publishes schema completion and retires a held schema read on disconnect", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let attempts = 0;
    const { runtimeConfig, state, client, publish } = await loadHarness(
      mockRequest({
        "config.schema": () => (++attempts === 1 ? first.promise : second.promise),
      }),
    );
    const initialLoad = runtimeConfig.ensureSchemaLoaded();
    const initial = runtimeConfig.schemaRead!;
    first.reject(new Error("Schema unavailable"));
    await initialLoad;
    expect(await initial).toEqual({ ok: false, error: "Schema unavailable" });

    const retry = runtimeConfig.ensureSchemaLoaded();
    const pending = runtimeConfig.schemaRead!;
    expect(pending).not.toBe(initial);
    publish(false, client);
    expect(runtimeConfig.schemaRead).toBeNull();
    second.resolve({ schema: { type: "object" }, uiHints: {}, version: "retired" });
    await retry;
    expect(state.configSchema).toBeNull();
    runtimeConfig.dispose();
  });

  it("does not load configuration for session-only connections, including reconnect refresh", async () => {
    const request = vi.fn(async () => ({ config: {}, hash: "ready", valid: true, issues: [] }));
    let auth: GatewayHelloOk["auth"] = { role: "operator", scopes: ["operator.sessions.read"] };
    const client = {
      request,
      get auth() {
        return auth;
      },
    } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const { state } = runtimeConfig;
    await runtimeConfig.ensureLoaded();
    await runtimeConfig.refreshSchema();
    publish(false, client);
    publish(true, client);
    await runtimeConfig.refresh();
    expect(request).not.toHaveBeenCalled();

    auth = { role: "operator", scopes: ["operator.admin"] };
    publish(false, client);
    publish(true, client);
    await runtimeConfig.ensureLoaded();
    expect(request).toHaveBeenCalledWith("config.get", {});
    expect(state.configSnapshot?.hash).toBe("ready");
    runtimeConfig.dispose();
  });

  it("config.set does not stage a default agent after access downgrades", async () => {
    const request = mockRequest({
      "config.get": () => ({
        sourceConfig: {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "reviewer" } },
            entries: {
              main: {},
              reviewer: {},
            },
          },
        },
        hash: "hash-1",
        valid: true,
        issues: [],
      }),
    });
    const { client, publish, runtimeConfig, state } = await loadHarness(request);

    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["config.get", "config.set"] },
    } as GatewayHelloOk);

    expect(runtimeConfig.stageDefaultAgent("main")).toBe(false);
    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toEqual({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "reviewer" } },
        entries: { main: {}, reviewer: {} },
      },
    });
    runtimeConfig.dispose();
  });

  it.each([true, false])(
    "refreshes a replacement with schema advertised: %s",
    async (advertised) => {
      let snapshot = makeSnapshot({ config: { endpoint: "initial" }, hash: "hash-initial" });
      let schema = { schema: {}, uiHints: {}, version: "schema-initial" };
      let current = false;
      const configRefresh = deferred();
      const routes = {
        "config.get": async () => {
          if (current && !advertised) {
            await configRefresh.promise;
          }
          return snapshot;
        },
        "config.schema": () => {
          if (current && !advertised) {
            throw new Error("unknown method: config.schema");
          }
          return schema;
        },
      };
      const requestA = mockRequest(routes);
      const requestB = mockRequest(routes);
      const { client: clientA, runtimeConfig, publish, state } = await loadHarness(requestA);
      const clientB = { request: requestB } as unknown as GatewayBrowserClient;
      await runtimeConfig.ensureSchemaLoaded();
      snapshot = makeSnapshot({ config: { endpoint: "current" }, hash: "hash-current" });
      schema = { ...schema, version: "schema-current" };
      current = true;
      publish(false, clientA);
      if (advertised) {
        publish(true, clientB);
      } else {
        publish(true, clientB, {
          type: "hello-ok",
          protocol: 1,
          auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
          features: { methods: ["config.get"] },
        } as GatewayHelloOk);
        await vi.waitFor(() => expect(state.configLoading).toBe(true));
        configRefresh.resolve();
      }
      await vi.waitFor(() => {
        expect(state.configSnapshot?.hash).toBe("hash-current");
        if (!advertised) {
          expect(state.lastError).toContain("unknown method: config.schema");
        }
      });
      expect(state.configForm).toEqual({ endpoint: "current" });
      expect(state.configSchemaVersion).toBe(advertised ? "schema-current" : "schema-initial");
      expect(requestB).not.toHaveBeenCalledWith("config.set", expect.anything());
      expect(requestB.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
      if (advertised) {
        expect(state.configFormDirty).toBe(false);
        expect(requestA.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
        expect(requestB).toHaveBeenCalledWith("config.get", {});
        expect(requestB).toHaveBeenCalledWith("config.schema", {});
      } else {
        expect(requestB.mock.calls.filter(([method]) => method === "config.schema")).toHaveLength(
          1,
        );
      }
      runtimeConfig.dispose();
    },
  );

  it("ignores a save completion from an earlier connection epoch", async () => {
    const save = deferred<unknown>();
    let getCount = 0;
    const request = mockRequest({
      "config.get": () => {
        getCount += 1;
        return makeSnapshot({ config: { value: getCount }, hash: `hash-${getCount}` });
      },
      "config.set": () => save.promise,
    });
    const { publish, runtimeConfig, state } = await loadHarness(request);
    runtimeConfig.patchForm(["value"], 2);

    const staleSave = runtimeConfig.save();
    publish(false);
    publish(true);
    save.resolve({});

    await expect(staleSave).resolves.toBe(false);
    expect(state).toMatchObject({ configFormDirty: true, configSaving: false });
    runtimeConfig.dispose();
  });

  it("rechecks operator access after the original-config parser settles", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { client, publish, runtimeConfig, state } = createConfigCapabilityHarness(server.request);
    const originalParse = deferred();

    await runtimeConfig.ensureLoaded();
    state.configRawOriginalParsePending = originalParse.promise;
    runtimeConfig.patchForm(["count"], 2);
    const timerAdvance = vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    await Promise.resolve();
    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["config.get", "config.set"] },
    } as GatewayHelloOk);
    originalParse.resolve();
    await timerAdvance;

    expect(server.submissions).toHaveLength(0);
    expect(state.configFormDirty).toBe(true);
    runtimeConfig.dispose();
  });

  it("continues mismatch polling after a transient config.get failure", async () => {
    vi.useFakeTimers();
    let getCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "config.get") {
        return {};
      }
      getCount += 1;
      if (getCount === 2) {
        throw new Error("gateway restarting");
      }
      return makeSnapshot({
        config: { count: 2 },
        raw: '{"count":2}',
        hash: "raw-hash-2",
        configRevisionHash: "revision-2",
        appliedConfigHash: getCount >= 3 ? "revision-2" : "revision-1",
      });
    });
    const { runtimeConfig, state } = await loadHarness(request);

    await vi.advanceTimersByTimeAsync(250);
    expect(state.configNeedsApply).toBe(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(state.configNeedsApply).toBe(false);
    runtimeConfig.dispose();
  });

  it.each(["save", "patch"] as const)(
    "invalidates an applied-hash poll during %s",
    async (operation) => {
      vi.useFakeTimers();
      const stalePoll = deferred<ConfigSnapshot>();
      const patchGate = deferred<unknown>();
      let getCount = 0;
      const pollSnapshot = (appliedConfigHash: string) =>
        makeSnapshot({
          raw: '{\n  "count": 1\n}\n',
          configRevisionHash: "revision-1",
          appliedConfigHash,
        });
      const request = mockRequest({
        "config.get": () => (++getCount === 2 ? stalePoll.promise : pollSnapshot("revision-0")),
        "config.set": () => ({ config: { count: 2 }, hash: "hash-2" }),
        "config.patch": () => patchGate.promise,
      });
      const { runtimeConfig, state } = createConfigCapabilityHarness(request);
      const initialLoad = runtimeConfig.ensureLoaded();
      if (operation === "save") {
        expect(state.configLoading).toBe(true);
      }
      await initialLoad;
      await vi.advanceTimersByTimeAsync(250);
      let patchPromise: Promise<boolean> | undefined;
      if (operation === "save") {
        expect(state.configLoading).toBe(false);
        runtimeConfig.patchForm(["count"], 2);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        expect(state.configSnapshot?.hash).toBe("hash-2");
      } else {
        patchPromise = runtimeConfig.patch({ raw: { count: 2 }, note: "test patch" });
        await vi.advanceTimersByTimeAsync(0);
      }
      stalePoll.resolve(pollSnapshot("revision-1"));
      await vi.advanceTimersByTimeAsync(operation === "save" ? 0 : 1_000);
      if (operation === "save") {
        expect(state).toMatchObject({ configSnapshot: { hash: "hash-2" }, configNeedsApply: true });
      } else {
        expect(getCount).toBe(2);
        patchGate.resolve({ config: { count: 2 }, hash: "hash-2" });
        await vi.advanceTimersByTimeAsync(0);
        await expect(patchPromise).resolves.toBe(true);
      }
      runtimeConfig.dispose();
    },
  );

  it("keeps a stranded dirty draft unsaved until an explicit save after replacement", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const replacementClient = {
      request: server.request,
    } as unknown as GatewayBrowserClient;
    const { runtimeConfig, publish, state } = await loadHarness(server.request);

    runtimeConfig.patchForm(["count"], 2);
    publish(false);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 3);
    expect(server.submissions).toHaveLength(0);
    expect(state.configFormDirty).toBe(true);

    publish(true, replacementClient);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
    expect(state.configFormDirty).toBe(true);
    // The reconnect pause must remain visible through subsequent edits.
    expect(state.configAutoSaveStatus).toBe("paused");

    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
    expect(state.configAutoSaveStatus).toBe("paused");

    await expect(runtimeConfig.save()).resolves.toBe(true);
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 3\n}\n', baseHash: "hash-1" },
    ]);
    expect(state).toMatchObject({ configFormDirty: false, configNeedsApply: true });
    expect(state.configAutoSaveStatus).not.toBe("paused");
    runtimeConfig.dispose();
  });

  it("flushes a dirty draft once on dispose instead of dropping it", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = await loadHarness(server.request);

    runtimeConfig.patchForm(["count"], 2);
    runtimeConfig.dispose();
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
    ]);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 4);
    expect(server.submissions).toHaveLength(1);
  });

  it("does not flush clean or raw drafts on dispose", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = await loadHarness(server.request);

    runtimeConfig.setRaw('{\n  "count": 5\n}\n');
    runtimeConfig.dispose();
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
  });

  it.each([false, true])("teardown chains a final save only for newer edits: %s", async (newer) => {
    const { submissions, firstSet, runtimeConfig } = await pendingAutoSave();
    if (newer) {
      runtimeConfig.patchForm(["count"], 3);
    }
    runtimeConfig.dispose();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(newer ? 0 : CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(newer ? 2 : 1);
    if (newer) {
      expect(submissions[1]).toEqual({ raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" });
    }
  });

  it("classifies an external mutation interrupted by disconnect as retryable", async () => {
    const mutation = deferred<unknown>();
    const request = mockRequest({
      "config.get": () => makeSnapshot({ raw: '{"count":1}' }),
      "plugins.setEnabled": () => mutation.promise,
    });
    const { runtimeConfig, publish } = await loadHarness(request);

    const resultPromise = runtimeConfig.runExternalMutation((client) =>
      client.request("plugins.setEnabled", { pluginId: "memory-core", enabled: true }),
    );
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("plugins.setEnabled", expect.anything()),
    );
    publish(false);
    mutation.reject(new Error("socket closed"));

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      error: "Connection changed before the configuration update completed.",
    });
    runtimeConfig.dispose();
  });

  it("does not retarget a suspended external mutation after the gateway changes", async () => {
    const requestA = mockRequest(
      {
        "config.get": () => makeSnapshot({ raw: '{"count":1}' }),
      },
      () => ({ ok: true }),
    );
    const requestB = vi.fn(async (_method: string) => ({ ok: true }));
    const clientA = { request: requestA } as unknown as GatewayBrowserClient;
    const clientB = { request: requestB } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(clientA);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    await runtimeConfig.ensureLoaded();
    requestA.mockClear();
    runtimeConfig.setWritesSuspended(true);

    const resultPromise = runtimeConfig.runExternalMutation(
      (client) => client.request("config.patch", { raw: '{"ui":{"prefs":{"locale":"de"}}}' }),
      { waitForWritesResumed: true },
    );
    await Promise.resolve();
    publish(true, clientB);
    runtimeConfig.setWritesSuspended(false);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      error: "Connection changed before the configuration update started.",
    });
    expect(requestA).not.toHaveBeenCalled();
    expect(requestB.mock.calls.map(([method]) => method)).toEqual(["config.get"]);
    expect(requestB).not.toHaveBeenCalledWith("config.patch", expect.anything());
    runtimeConfig.dispose();
  });

  it.each([false, true])(
    "reconciles an interrupted save (first read fails: %s)",
    async (failRead) => {
      vi.useFakeTimers();
      let committedRaw = '{\n  "count": 1\n}\n';
      let hash = "hash-1";
      let failNextGet = false;
      const sets: Array<{ raw: string; baseHash: string }> = [];
      const request = mockRequest({
        "config.get": () => {
          if (failNextGet) {
            failNextGet = false;
            throw new Error("gateway hiccup");
          }
          return makeSnapshot({ config: JSON.parse(committedRaw), raw: committedRaw, hash });
        },
        "config.set": (params) => {
          const submission = params as { raw: string; baseHash: string };
          sets.push(submission);
          committedRaw = submission.raw;
          hash = sets.length === 1 ? "hash-2" : "hash-3";
          return sets.length === 1
            ? new Promise(() => {})
            : { config: JSON.parse(committedRaw), hash };
        },
      });
      const { runtimeConfig, publish, state } = await loadHarness(request);
      runtimeConfig.patchForm(["count"], 2);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(sets).toHaveLength(1);
      if (!failRead) {
        runtimeConfig.patchForm(["count"], 3);
      }
      failNextGet = failRead;
      publish(false);
      publish(true);
      if (failRead) {
        await vi.advanceTimersByTimeAsync(0);
        expect(state.configNeedsApply).toBe(false);
        publish(false);
        publish(true);
      }
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(sets).toHaveLength(1);
      if (failRead) {
        expect(state).toMatchObject({ configNeedsApply: true, configFormDirty: false });
      } else {
        expect(state).toMatchObject({ configFormDirty: true, configDraftBaseHash: "hash-2" });
        await expect(runtimeConfig.save()).resolves.toBe(true);
        expect(sets).toHaveLength(2);
        expect(sets[1]).toEqual({ raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" });
        expect(state.configAutoSaveStatus).toBe("saved");
      }
      runtimeConfig.dispose();
    },
  );

  it("lets a reconnected explicit op bypass a dead prior-connection FIFO", async () => {
    const deadSet = deferred<unknown>();
    const methods: string[] = [];
    const request = mockRequest(
      {
        "config.get": () => makeSnapshot(),
        "config.set": () => deadSet.promise,
      },
      () => ({
        config: { count: 1, ui: { prefs: { themeMode: "dark" } } },
        hash: "hash-2",
      }),
      methods,
    );
    const { runtimeConfig, publish } = await loadHarness(request);

    void runtimeConfig.save();
    void runtimeConfig.apply();
    await vi.waitFor(() => expect(methods).toContain("config.set"));
    publish(false);
    publish(true);

    await expect(
      runtimeConfig.patch({ raw: { ui: { prefs: { themeMode: "dark" } } }, note: "test" }),
    ).resolves.toBe(true);
    expect(methods).toContain("config.patch");
    expect(methods).not.toContain("config.apply");
    runtimeConfig.dispose();
  });

  it.each(["reconnect", "access"] as const)(
    "does not dispatch a queued write after %s changes",
    async (change) => {
      const firstPatch = deferred<unknown>();
      let patchCalls = 0;
      let setCalls = 0;
      const request = mockRequest({
        "config.get": () => makeSnapshot(),
        "config.patch": () => {
          patchCalls += 1;
          return firstPatch.promise;
        },
        "config.set": () => {
          setCalls += 1;
          return {};
        },
      });
      const { runtimeConfig, publish } = await loadHarness(request);
      const patch = runtimeConfig.patch({ raw: { ui: { prefs: {} } }, note: "test" });
      const save = runtimeConfig.save();
      await vi.waitFor(() => expect(patchCalls).toBe(1));
      if (change === "reconnect") {
        publish(false);
        publish(true);
      } else {
        publish(true, undefined, {
          type: "hello-ok",
          protocol: 4,
          auth: { role: "operator", scopes: ["operator.read"] },
          features: { methods: ["config.get", "config.patch", "config.set"] },
        } as GatewayHelloOk);
      }
      firstPatch.resolve({ config: { count: 1 }, noop: true });
      if (change === "reconnect") {
        await expect(patch).resolves.toBe(false);
      } else {
        await patch;
      }
      await expect(save).resolves.toBe(false);
      expect(setCalls).toBe(0);
      if (change === "access") {
        expect(runtimeConfig.canSet).toBe(false);
      }
      runtimeConfig.dispose();
    },
  );

  it.each(["save", "patch"] as const)(
    "rechecks the caller lifecycle before a queued config %s dispatches",
    async (action) => {
      const firstPatch = deferred<unknown>();
      const methods: string[] = [];
      let canDispatch = true;
      const request = vi.fn((method: string) => {
        methods.push(method);
        if (method === "config.get") {
          return Promise.resolve(makeSnapshot({ raw: '{"count":1}' }));
        }
        if (method === "config.patch" && methods.filter((entry) => entry === method).length === 1) {
          return firstPatch.promise;
        }
        return Promise.resolve({});
      });
      const { runtimeConfig } = await loadHarness(request);
      methods.length = 0;

      const activePatch = runtimeConfig.patch({ raw: { count: 2 }, note: "active" });
      const queued =
        action === "save"
          ? runtimeConfig.save({ canDispatch: () => canDispatch })
          : runtimeConfig.patch({
              raw: { count: 3 },
              note: "queued",
              canDispatch: () => canDispatch,
            });
      await vi.waitFor(() => expect(methods).toEqual(["config.patch"]));
      canDispatch = false;
      firstPatch.resolve({ config: { count: 2 }, hash: "hash-2" });

      await expect(activePatch).resolves.toBe(true);
      await expect(queued).resolves.toBe(false);
      expect(methods).toEqual(["config.patch"]);
      runtimeConfig.dispose();
    },
  );

  it("rechecks operator access after parsing before config.apply dispatch", async () => {
    const server = createConfigServerMock();
    const { client, publish, runtimeConfig, state } = createConfigCapabilityHarness(server.request);
    const originalParse = deferred();

    await runtimeConfig.ensureLoaded();
    state.configRawOriginalParsePending = originalParse.promise;
    const result = runtimeConfig.apply();
    await Promise.resolve();
    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["config.get", "config.apply", "config.set"] },
    } as GatewayHelloOk);
    originalParse.resolve();

    await expect(result).resolves.toBe(false);
    expect(server.submissions).toHaveLength(0);
    runtimeConfig.dispose();
  });

  it("frees write drains when a disconnect orphans a hung request", async () => {
    vi.useFakeTimers();
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return Promise.resolve(makeSnapshot({ raw: '{\n  "count": 1\n}\n' }));
      }
      if (method === "config.set") {
        // The connection dies before this ever settles.
        return new Promise(() => {});
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, publish } = await loadHarness(request);

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    let drained = false;
    const drainPromise = runtimeConfig.waitForPendingWrites().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);

    // Disconnect must release existing drains even if the transport never settles.
    publish(false);
    await drainPromise;
    expect(drained).toBe(true);
    runtimeConfig.dispose();
  });

  it("keeps the conflict status through an offline discard", async () => {
    vi.useFakeTimers();
    const request = mockRequest({
      "config.get": () => makeSnapshot({ raw: '{\n  "count": 1\n}\n' }),
      "config.set": () => {
        throw new Error("config changed since last load; re-run config.get and retry");
      },
    });
    const { runtimeConfig, publish, state } = await loadHarness(request);

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(state.configAutoSaveStatus).toBe("conflict");

    // Local discard cannot reconcile the stale server snapshot.
    publish(false);
    await runtimeConfig.discardDraft();
    expect(state).toMatchObject({ configFormDirty: false, configRaw: '{\n  "count": 1\n}\n' });
    expect(state.configAutoSaveStatus).toBe("conflict");
    runtimeConfig.dispose();
  });
});

describe("runtime config load subscriptions", () => {
  it("clears a settled load when an observer throws so an explicit retry can read again", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("temporarily unavailable"));
    request.mockResolvedValue({ config: {}, hash: "ready", valid: true, issues: [] });
    const { runtimeConfig, state } = createConfigCapabilityHarness(request);
    const unsubscribe = runtimeConfig.subscribe((observedState) => {
      if (!observedState.configLoading && !observedState.configSnapshot) {
        throw new Error("observer failed");
      }
    });
    try {
      await expect(runtimeConfig.ensureLoaded()).rejects.toThrow("observer failed");
      unsubscribe();
      await runtimeConfig.ensureLoaded();
      expect(request).toHaveBeenCalledTimes(2);
      expect(state.configSnapshot?.hash).toBe("ready");
    } finally {
      unsubscribe();
      runtimeConfig.dispose();
    }
  });

  it("refresh lets an offline editor ensure config without recursive notifications", async () => {
    const request = vi.fn(async () => ({ config: {}, hash: "ready", valid: true, issues: [] }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    publish(false);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const { state } = runtimeConfig;
    const pending: Promise<void>[] = [];
    let depth = 0;
    let maxDepth = 0;
    const unsubscribe = runtimeConfig.subscribe((observedState) => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      // Bound a broken implementation so the regression reports re-entry,
      // rather than exhausting the process stack before cleanup can run.
      if (depth < 3 && !observedState.configSnapshot && !observedState.configLoading) {
        pending.push(runtimeConfig.ensureLoaded());
      }
      depth -= 1;
    });
    try {
      await runtimeConfig.refresh();
      await Promise.all(pending);
      expect(maxDepth).toBe(1);
      expect(request).not.toHaveBeenCalled();

      publish(true);
      await runtimeConfig.ensureLoaded();
      expect(request).toHaveBeenCalledOnce();
      expect(state.configSnapshot?.hash).toBe("ready");
    } finally {
      unsubscribe();
      runtimeConfig.dispose();
    }
  });

  it("publishes schema loading immediately and leaves a failed read for explicit retry", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("temporarily unavailable"));
    request.mockResolvedValue({
      config: {},
      hash: "ready",
      valid: true,
      issues: [],
      schema: { type: "object" },
      uiHints: {},
      version: "ready",
    });
    const { runtimeConfig, state } = createConfigCapabilityHarness(request);
    const ensure = () => runtimeConfig.ensureSchemaLoaded();
    const loading = () => state.configSchemaLoading;
    const loaded = () => state.configSchema;
    const observed: boolean[] = [];
    const unsubscribe = runtimeConfig.subscribe(() => {
      observed.push(loading());
      if (!loading() && !loaded()) {
        void ensure();
      }
    });
    try {
      const first = ensure();
      expect(loading()).toBe(true);
      expect(observed).toContain(true);
      await first;
      expect(request).toHaveBeenCalledOnce();
      expect(loaded()).toBeNull();
      expect(state.lastError).toContain("temporarily unavailable");

      await ensure();
      expect(request).toHaveBeenCalledTimes(2);
      expect(loaded()).not.toBeNull();
    } finally {
      unsubscribe();
      runtimeConfig.dispose();
    }
  });
});

describe("runtime config schema access", () => {
  it("loads the schema for a legacy hello without scopes or an advertised method list", async () => {
    const schema = {
      schema: { type: "object" },
      uiHints: {},
      version: "schema-legacy",
      generatedAt: "2026-08-15T00:00:00.000Z",
    };
    const request = vi.fn(async (method: string) =>
      method === "config.get"
        ? { config: {}, hash: "hash-legacy", valid: true, issues: [] }
        : method === "config.schema"
          ? schema
          : {},
    );
    const { client, publish, runtimeConfig, state } = createConfigCapabilityHarness(request);
    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator" },
    } as GatewayHelloOk);
    await runtimeConfig.ensureSchemaLoaded();

    expect(request).toHaveBeenCalledWith("config.schema", {});
    expect(state.configSchemaVersion).toBe("schema-legacy");
    runtimeConfig.dispose();
  });

  it("skips the schema load when advertised scopes exclude operator.read", async () => {
    const request = vi.fn(async () => ({}));
    const { client, publish, runtimeConfig } = createConfigCapabilityHarness(request);
    publish(true, client, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.pairing"] },
      features: { methods: ["config.schema"] },
    } as GatewayHelloOk);
    await runtimeConfig.ensureSchemaLoaded();

    expect(request).not.toHaveBeenCalledWith("config.schema", {});
    runtimeConfig.dispose();
  });
});
