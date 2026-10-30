// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigServerMock,
  createDeferredSetServerMock,
} from "./config-test-harness.ts";
import {
  loadHarness,
  makeSnapshot,
  mockRequest,
  pendingAutoSave,
} from "./config-write.test-support.ts";

describe("config write coordinator", () => {
  it.each([false, true])(
    "config.set rebinds only an unchanged reconnect base (changed: %s)",
    async (changed) => {
      vi.useFakeTimers();
      let hash = "legacy-raw-hash";
      let raw = '{\n  "count": 1\n}\n';
      const submissions: Array<{ raw: string; baseHash: string }> = [];
      const request = mockRequest({
        "config.get": () => makeSnapshot({ config: JSON.parse(raw), raw, hash }),
        "config.set": (params) => {
          const submission = params as { raw: string; baseHash: string };
          submissions.push(submission);
          if (changed && submission.baseHash !== hash) {
            throw new Error("config changed since last load; re-run config.get and retry");
          }
          return { config: JSON.parse(submission.raw), hash: "opaque-next" };
        },
      });
      const { runtimeConfig, publish, state } = await loadHarness(request);
      runtimeConfig.patchForm(["count"], 2);
      publish(false);
      if (changed) {
        raw = '{\n  "count": 9\n}\n';
      }
      hash = "opaque-current";
      publish(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(state.configForm).toEqual({ count: 2 });
      expect(state.configDraftBaseHash).toBe(changed ? "legacy-raw-hash" : hash);
      if (!changed) {
        expect(state).toMatchObject({ configFormDirty: true, configAutoSaveStatus: "paused" });
      }
      await expect(runtimeConfig.save()).resolves.toBe(!changed);
      expect(submissions).toEqual([
        {
          raw: '{\n  "count": 2\n}\n',
          baseHash: changed ? "legacy-raw-hash" : "opaque-current",
        },
      ]);
      if (changed) {
        expect(state.configAutoSaveStatus).toBe("conflict");
      }
      runtimeConfig.dispose();
    },
  );

  it("surfaces an operator.admin reason when config mutations are out of scope", async () => {
    const server = createConfigServerMock();
    const { runtimeConfig, publish, state } = await loadHarness(server.request);
    publish(true, undefined, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
      features: { methods: ["config.get", "config.set", "config.patch"] },
    } as GatewayHelloOk);

    await expect(
      runtimeConfig.patch({ raw: { count: 2 }, note: "out-of-scope patch" }),
    ).resolves.toBe(false);
    expect(state.lastError).toBe("Configuration changes require operator.admin access.");
    expect(server.submissions).toHaveLength(0);
    runtimeConfig.dispose();
  });

  it("drains the whole autosave chain before an explicit apply", async () => {
    const { submissions, applySubmissions, firstSet, runtimeConfig } = await pendingAutoSave();

    // Apply must use the trailing save's acknowledged CAS base.
    runtimeConfig.patchForm(["count"], 3);
    const applyPromise = runtimeConfig.apply();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await expect(applyPromise).resolves.toBe(true);

    expect(submissions).toEqual([
      { raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
      { raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" },
    ]);
    expect(applySubmissions).toEqual([{ raw: '{\n  "count": 3\n}\n', baseHash: "hash-3" }]);
    runtimeConfig.dispose();
  });

  it("skips the teardown flush when the pending save fails", async () => {
    const { submissions, firstSet, runtimeConfig } = await pendingAutoSave();

    // A failed flight cannot supply the teardown flush's CAS base.
    runtimeConfig.patchForm(["count"], 3);
    runtimeConfig.dispose();
    firstSet.reject(new Error("write unavailable"));
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);
  });

  it("drains saves without trailing discarded bytes on reload", async () => {
    const { submissions, firstSet, runtimeConfig, state } = await pendingAutoSave();

    runtimeConfig.patchForm(["count"], 3);
    const discardPromise = runtimeConfig.discardDraft({ reloadOnly: true });
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await discardPromise;

    expect(submissions).toHaveLength(1);
    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toEqual({ count: 2 });
    runtimeConfig.dispose();
  });

  it("suspends config writes while the app updater runs and resumes after", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig, state } = await loadHarness(server.request);

    runtimeConfig.setWritesSuspended(true);
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 3);
    expect(server.submissions).toHaveLength(0);
    expect(state.configFormDirty).toBe(true);

    await expect(runtimeConfig.save()).resolves.toBe(false);
    await expect(runtimeConfig.apply()).resolves.toBe(false);
    expect(server.submissions).toHaveLength(0);

    runtimeConfig.setWritesSuspended(false);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
    ]);
    runtimeConfig.dispose();
  });

  it("config.set flushes a scheduled autosave when a write barrier runs before the debounce", async () => {
    vi.useFakeTimers();
    const setGate = deferred<unknown>();
    const methods: string[] = [];
    const request = mockRequest(
      {
        "config.get": () => makeSnapshot({ raw: '{\n  "count": 1\n}\n' }),
        "config.set": (params) => {
          expect(params).toMatchObject({ baseHash: "hash-1" });
          return setGate.promise;
        },
      },
      undefined,
      methods,
    );
    const { runtimeConfig, state } = await loadHarness(request);

    runtimeConfig.patchForm(["count"], 2);
    let drained = false;
    const drain = runtimeConfig.waitForPendingWrites().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(methods.filter((method) => method === "config.set")).toHaveLength(1);
    expect(drained).toBe(false);

    setGate.resolve({ config: { count: 2 }, hash: "hash-2" });
    await drain;
    expect(drained).toBe(true);
    expect(state.configSnapshot?.hash).toBe("hash-2");
    runtimeConfig.dispose();
  });

  it("config.set rechecks external mutation access after pending config writes settle", async () => {
    vi.useFakeTimers();
    const firstSet = deferred<unknown>();
    const methods: string[] = [];
    let canDispatch = true;
    const request = mockRequest(
      {
        "config.get": () => makeSnapshot({ raw: '{"count":1}' }),
        "config.set": () => firstSet.promise,
      },
      () => ({ ok: true }),
      methods,
    );
    const { runtimeConfig } = await loadHarness(request);
    methods.length = 0;

    runtimeConfig.patchForm(["count"], 2);
    const result = runtimeConfig.runExternalMutation(
      (client) => client.request("agents.update", { agentId: "main", name: "Agent Smith" }),
      {
        canDispatch: () => canDispatch,
        dispatchError: "Access changed before the agent identity update started.",
      },
    );
    await vi.waitFor(() => expect(methods).toEqual(["config.set"]));
    canDispatch = false;
    firstSet.resolve({ config: { count: 2 }, hash: "hash-2" });

    await expect(result).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      error: "Access changed before the agent identity update started.",
    });
    expect(methods).toEqual(["config.set"]);
    runtimeConfig.dispose();
  });

  it("forces a post-mutation refresh instead of joining a pre-existing config load", async () => {
    const staleLoad = deferred<ConfigSnapshot>();
    let getCalls = 0;
    let storedConfig: Record<string, unknown> = { count: 1 };
    let hash = "hash-1";
    const request = mockRequest({
      "config.get": () => {
        getCalls += 1;
        if (getCalls === 2) {
          return staleLoad.promise;
        }
        return makeSnapshot({ config: storedConfig, raw: JSON.stringify(storedConfig), hash });
      },
      "plugins.setEnabled": () => {
        storedConfig = { count: 1, pluginEnabled: true };
        hash = "hash-2";
        return { ok: true };
      },
    });
    const { runtimeConfig, state } = await loadHarness(request);

    const overlappingRefresh = runtimeConfig.refresh();
    await vi.waitFor(() => expect(getCalls).toBe(2));
    const result = await runtimeConfig.runExternalMutation((client) =>
      client.request("plugins.setEnabled", { pluginId: "memory-core", enabled: true }),
    );

    expect(result.ok).toBe(true);
    expect(getCalls).toBe(3);
    expect(state.configSnapshot?.hash).toBe("hash-2");
    expect(state.configForm).toEqual({ count: 1, pluginEnabled: true });

    staleLoad.resolve(
      makeSnapshot({ config: { count: 999 }, raw: '{"count":999}', hash: "stale-hash" }),
    );
    await overlappingRefresh;
    expect(state.configSnapshot?.hash).toBe("hash-2");
    runtimeConfig.dispose();
  });

  it("distinguishes definitive external mutation rejections from transient errors", async () => {
    const request = mockRequest({
      "config.get": () => makeSnapshot({ raw: '{"count":1}' }),
    });
    const { runtimeConfig } = await loadHarness(request);

    await expect(
      runtimeConfig.runExternalMutation(async () => {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "invalid config",
        });
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "rejected",
      error: "invalid config",
    });
    await expect(
      runtimeConfig.runExternalMutation(async () => {
        throw new Error("socket closed");
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      error: "socket closed",
    });
    runtimeConfig.dispose();
  });

  it("preserves queued mutation waiters when suspension is repeated", async () => {
    const methods: string[] = [];
    const request = mockRequest(
      {
        "config.get": () => makeSnapshot({ raw: '{"count":1}' }),
      },
      () => ({ ok: true }),
      methods,
    );
    const { runtimeConfig } = await loadHarness(request);
    methods.length = 0;
    runtimeConfig.setWritesSuspended(true);

    const resultPromise = runtimeConfig.runExternalMutation(
      (client) => client.request("config.patch", { raw: '{"ui":{"prefs":{"locale":"de"}}}' }),
      { waitForWritesResumed: true },
    );
    await Promise.resolve();
    runtimeConfig.setWritesSuspended(true);
    runtimeConfig.setWritesSuspended(false);

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      value: { ok: true },
      refresh: { ok: true },
    });
    expect(methods).toEqual(["config.patch", "config.get"]);
    runtimeConfig.dispose();
  });

  it("config.set retries a background mutation when suspension begins during its write drain", async () => {
    vi.useFakeTimers();
    const firstSet = deferred<unknown>();
    const methods: string[] = [];
    const request = mockRequest(
      {
        "config.get": () =>
          makeSnapshot({
            raw: '{"count":1}',
            hash: methods.filter((entry) => entry === "config.set").length ? "hash-2" : "hash-1",
          }),
        "config.set": () => firstSet.promise,
      },
      () => ({ ok: true }),
      methods,
    );
    const { runtimeConfig } = await loadHarness(request);
    methods.length = 0;

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    const resultPromise = runtimeConfig.runExternalMutation(
      (client) => client.request("config.patch", { raw: '{"ui":{"prefs":{"locale":"de"}}}' }),
      { waitForWritesResumed: true },
    );
    runtimeConfig.setWritesSuspended(true);
    firstSet.resolve({ config: { count: 2 }, hash: "hash-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(methods).toEqual(["config.set"]);

    runtimeConfig.setWritesSuspended(false);
    await expect(resultPromise).resolves.toEqual({
      ok: true,
      value: { ok: true },
      refresh: { ok: true },
    });
    expect(methods).toEqual(["config.set", "config.patch", "config.get"]);
    runtimeConfig.dispose();
  });

  it("serializes explicit ops queued behind the same in-flight write", async () => {
    const { submissions, applySubmissions, firstSet, runtimeConfig } = await pendingAutoSave();

    // Each queued operation must use its predecessor's acknowledged base.
    const savePromise = runtimeConfig.save();
    const applyPromise = runtimeConfig.apply();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await expect(savePromise).resolves.toBe(true);
    await expect(applyPromise).resolves.toBe(true);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]?.baseHash).toBe("hash-2");
    expect(applySubmissions).toHaveLength(1);
    expect(applySubmissions[0]?.baseHash).toBe("hash-3");
    runtimeConfig.dispose();
  });

  it("defers autosaves behind a manual write and keeps the newer edit", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig, state } = await loadHarness(request);

    runtimeConfig.patchForm(["count"], 2);
    const savePromise = runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    expect(submissions).toHaveLength(1);

    // Newer edits must neither race the pending save nor be lost to its ack.
    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(submissions).toHaveLength(1);

    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await savePromise;
    await vi.advanceTimersByTimeAsync(0);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" });
    expect(state.configForm).toEqual({ count: 3 });
    expect(state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it.each([false, true])(
    "preserves the offline discard policy after draining (reloadOnly: %s)",
    async (reloadOnly) => {
      const { request, submissions, firstSet, runtimeConfig, publish, state } =
        await pendingAutoSave();

      runtimeConfig.patchForm(["count"], 3);
      const discardPromise = runtimeConfig.discardDraft({ reloadOnly });
      publish(false);
      await discardPromise;

      expect(state.configForm).toEqual({ count: reloadOnly ? 3 : 1 });
      expect(state.configFormDirty).toBe(reloadOnly);
      expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);

      // A disconnected write's late acknowledgement cannot replace either result.
      firstSet.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      expect(submissions).toHaveLength(1);
      expect(state.configForm).toEqual({ count: reloadOnly ? 3 : 1 });
      expect(state.configFormDirty).toBe(reloadOnly);
      runtimeConfig.dispose();
    },
  );

  it("flushes a scheduled form autosave before config.patch and re-arms after", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let hashCounter = 1;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return Promise.resolve(
          makeSnapshot({ raw: '{\n  "count": 1\n}\n', hash: `hash-${hashCounter}` }),
        );
      }
      if (method === "config.set" || method === "config.patch") {
        order.push(method);
        hashCounter += 1;
        return Promise.resolve({ config: { count: 2, other: true }, hash: `hash-${hashCounter}` });
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, state } = await loadHarness(request);

    runtimeConfig.patchForm(["count"], 2);
    let patchBaseCount: unknown;
    await expect(
      runtimeConfig.patchFromSnapshot((config) => {
        patchBaseCount = config.count;
        return {
          options: { raw: { other: true }, note: "test patch after autosave" },
        };
      }),
    ).resolves.toBe(true);

    expect(order).toEqual(["config.set", "config.patch"]);
    expect(patchBaseCount).toBe(2);
    expect(state.configFormDirty).toBe(false);
    runtimeConfig.dispose();
  });

  it("config.apply chains the final form edit from its acknowledged revision during teardown", async () => {
    vi.useFakeTimers();
    const firstApply = deferred<unknown>();
    let setCalls = 0;
    const request = mockRequest({
      "config.get": () => makeSnapshot({ raw: '{\n  "count": 1\n}\n' }),
      "config.set": () => {
        setCalls += 1;
        return { config: { count: 3 }, hash: "hash-9" };
      },
      "config.apply": () =>
        firstApply.promise.then(() => ({ config: { count: 2 }, hash: "hash-2" })),
    });
    const { runtimeConfig, state } = await loadHarness(request);

    runtimeConfig.patchForm(["count"], 2);
    const applyPromise = runtimeConfig.apply();
    await vi.advanceTimersByTimeAsync(0);

    // Apply can hot-reload without disconnecting this client.
    runtimeConfig.patchForm(["count"], 3);
    runtimeConfig.dispose();
    firstApply.resolve({});
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    await applyPromise;
    expect(setCalls).toBe(1);
    expect(request).toHaveBeenCalledWith("config.set", {
      raw: '{\n  "count": 3\n}\n',
      baseHash: "hash-2",
    });
    expect(state.configDraftBaseHash).toBe("hash-9");
  });
});
