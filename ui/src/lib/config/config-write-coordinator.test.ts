// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigServerMock,
  createDeferredSetServerMock,
  createConfigCapabilityHarness,
} from "./config-test-harness.ts";

describe("config write coordinator", () => {
  it("config.set rebinds a retained draft to an opaque revision when the reconnect base is unchanged", async () => {
    vi.useFakeTimers();
    let hash = "legacy-raw-hash";
    const raw = '{\n  "count": 1\n}\n';
    const submissions: Array<{ raw: string; baseHash: string }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return { config: { count: 1 }, raw, hash, valid: true, issues: [] };
      }
      if (method === "config.set") {
        submissions.push(params as { raw: string; baseHash: string });
        return { config: JSON.parse((params as { raw: string }).raw), hash: "opaque-next" };
      }
      return {};
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);

    publish(false);
    hash = "opaque-current";
    publish(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("opaque-current");
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
    await expect(runtimeConfig.save()).resolves.toBe(true);
    expect(submissions).toEqual([{ raw: '{\n  "count": 2\n}\n', baseHash: "opaque-current" }]);
    runtimeConfig.dispose();
  });

  it("config.set keeps the old revision and conflicts when the reconnect base changed", async () => {
    vi.useFakeTimers();
    let hash = "legacy-raw-hash";
    let raw = '{\n  "count": 1\n}\n';
    const submissions: Array<{ raw: string; baseHash: string }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return { config: JSON.parse(raw), raw, hash, valid: true, issues: [] };
      }
      if (method === "config.set") {
        const submission = params as { raw: string; baseHash: string };
        submissions.push(submission);
        if (submission.baseHash !== hash) {
          throw new Error("config changed since last load; re-run config.get and retry");
        }
        return { config: JSON.parse((params as { raw: string }).raw), hash: "opaque-next" };
      }
      return {};
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);

    publish(false);
    raw = '{\n  "count": 9\n}\n';
    hash = "opaque-current";
    publish(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    expect(runtimeConfig.state.configDraftBaseHash).toBe("legacy-raw-hash");
    await expect(runtimeConfig.save()).resolves.toBe(false);
    expect(submissions).toEqual([{ raw: '{\n  "count": 2\n}\n', baseHash: "legacy-raw-hash" }]);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
    runtimeConfig.dispose();
  });

  it("surfaces an operator.admin reason when config mutations are out of scope", async () => {
    const server = createConfigServerMock();
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    publish(true, undefined, {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
      features: { methods: ["config.get", "config.set", "config.patch"] },
    } as GatewayHelloOk);

    await expect(
      runtimeConfig.patch({ raw: { count: 2 }, note: "out-of-scope patch" }),
    ).resolves.toBe(false);
    expect(runtimeConfig.state.lastError).toBe(
      "Configuration changes require operator.admin access.",
    );
    expect(server.submissions).toHaveLength(0);
    runtimeConfig.dispose();
  });

  it("drains the whole autosave chain before an explicit apply", async () => {
    vi.useFakeTimers();
    const { request, submissions, applySubmissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // Edit while the save is in flight, then apply: the trailing save must
    // land first and the apply must chain onto ITS ack hash (no CAS failure).
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
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // Without the flight's own ack hash there is no trusted CAS base for the
    // final flush; failing closed beats clobbering a foreign write.
    runtimeConfig.patchForm(["count"], 3);
    runtimeConfig.dispose();
    firstSet.reject(new Error("write unavailable"));
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);
  });

  it("drains saves without trailing discarded bytes on reload", async () => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // A mid-flight edit would normally spawn a trailing save; a discard must
    // wait for the flight and then throw the draft away instead.
    runtimeConfig.patchForm(["count"], 3);
    const discardPromise = runtimeConfig.discardDraft({ reloadOnly: true });
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await discardPromise;

    expect(submissions).toHaveLength(1);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    // The draft ends clean against the acked/reloaded state, not the old bytes.
    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    runtimeConfig.dispose();
  });

  it("suspends config writes while the app updater runs and resumes after", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.setWritesSuspended(true);
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 3);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    // Manual writes refuse too: config writes mid-update can corrupt the install.
    await expect(runtimeConfig.save()).resolves.toBe(false);
    await expect(runtimeConfig.apply()).resolves.toBe(false);
    expect(server.submissions).toHaveLength(0);

    // Edits made during the update save once it ends.
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
    const request = vi.fn((method: string, params?: unknown) => {
      methods.push(method);
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        expect(params).toMatchObject({ baseHash: "hash-1" });
        return setGate.promise;
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

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
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    runtimeConfig.dispose();
  });

  it("config.set rechecks external mutation access after pending config writes settle", async () => {
    vi.useFakeTimers();
    const firstSet = deferred<unknown>();
    const methods: string[] = [];
    let canDispatch = true;
    const request = vi.fn((method: string) => {
      methods.push(method);
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        return firstSet.promise;
      }
      return Promise.resolve({ ok: true });
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
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
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        getCalls += 1;
        if (getCalls === 2) {
          return staleLoad.promise;
        }
        return {
          config: storedConfig,
          raw: JSON.stringify(storedConfig),
          hash,
          valid: true,
          issues: [],
        };
      }
      if (method === "plugins.setEnabled") {
        storedConfig = { count: 1, pluginEnabled: true };
        hash = "hash-2";
        return { ok: true };
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const overlappingRefresh = runtimeConfig.refresh();
    await vi.waitFor(() => expect(getCalls).toBe(2));
    const result = await runtimeConfig.runExternalMutation((client) =>
      client.request("plugins.setEnabled", { pluginId: "memory-core", enabled: true }),
    );

    expect(result.ok).toBe(true);
    expect(getCalls).toBe(3);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    expect(runtimeConfig.state.configForm).toEqual({ count: 1, pluginEnabled: true });

    staleLoad.resolve({
      config: { count: 999 },
      raw: '{"count":999}',
      hash: "stale-hash",
      valid: true,
      issues: [],
    });
    await overlappingRefresh;
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    runtimeConfig.dispose();
  });

  it("distinguishes definitive external mutation rejections from transient errors", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          config: { count: 1 },
          raw: '{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

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
    const request = vi.fn(async (method: string) => {
      methods.push(method);
      if (method === "config.get") {
        return {
          config: { count: 1 },
          raw: '{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      return { ok: true };
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
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
    const request = vi.fn((method: string) => {
      methods.push(method);
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{"count":1}',
          hash: methods.filter((entry) => entry === "config.set").length ? "hash-2" : "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        return firstSet.promise;
      }
      return Promise.resolve({ ok: true });
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
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
    vi.useFakeTimers();
    const { request, submissions, applySubmissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);

    // Both ops queue behind the hung autosave; they must dispatch one after
    // another, each against the base its predecessor produced — not both
    // against the drained flight's base.
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    const savePromise = runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    expect(submissions).toHaveLength(1);

    // Edit while the manual save is pending: no concurrent config.set may
    // start (it would race the same base hash), and the manual completion
    // must not snap the draft back to its older submitted bytes.
    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(submissions).toHaveLength(1);

    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await savePromise;
    await vi.advanceTimersByTimeAsync(0);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configForm).toEqual({ count: 3 });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it.each([false, true])(
    "preserves the offline discard policy after draining (reloadOnly: %s)",
    async (reloadOnly) => {
      vi.useFakeTimers();
      const { request, submissions, firstSet } = createDeferredSetServerMock();
      const { runtimeConfig, publish } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      await runtimeConfig.ensureLoaded();

      runtimeConfig.patchForm(["count"], 2);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(submissions).toHaveLength(1);

      runtimeConfig.patchForm(["count"], 3);
      const discardPromise = runtimeConfig.discardDraft({ reloadOnly });
      publish(false);
      await discardPromise;

      expect(runtimeConfig.state.configForm).toEqual({ count: reloadOnly ? 3 : 1 });
      expect(runtimeConfig.state.configFormDirty).toBe(reloadOnly);
      expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);

      // A disconnected write's late acknowledgement cannot replace either result.
      firstSet.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      expect(submissions).toHaveLength(1);
      expect(runtimeConfig.state.configForm).toEqual({ count: reloadOnly ? 3 : 1 });
      expect(runtimeConfig.state.configFormDirty).toBe(reloadOnly);
      runtimeConfig.dispose();
    },
  );

  it("flushes a scheduled form autosave before config.patch and re-arms after", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let hashCounter = 1;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set" || method === "config.patch") {
        order.push(method);
        hashCounter += 1;
        return Promise.resolve({ config: { count: 2, other: true }, hash: `hash-${hashCounter}` });
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    // Patch during the debounce window: the draft must be flushed as a real
    // save before the patch, not silently dropped with its timer.
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
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    runtimeConfig.dispose();
  });

  it("config.apply chains the final form edit from its acknowledged revision during teardown", async () => {
    vi.useFakeTimers();
    const firstApply = deferred<unknown>();
    let setCalls = 0;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        setCalls += 1;
        return Promise.resolve({ config: { count: 3 }, hash: "hash-9" });
      }
      if (method === "config.apply") {
        return firstApply.promise.then(() => ({ config: { count: 2 }, hash: "hash-2" }));
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

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
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-9");
  });
});
