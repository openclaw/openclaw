// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigPatchAck } from "./config-gateway-operations.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
  createConfigServerMock,
  createDeferredSetServerMock,
  deferred,
} from "./config-test-harness.ts";

describe("acknowledged config revision", () => {
  it("config.patch through runExternalMutation before loading does not invent a pending draft", async () => {
    const store = createConfigServerMock();
    const request = vi.fn((method: string, params?: unknown) =>
      store.request(method === "config.patch" ? "config.set" : method, params),
    );
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.runExternalMutation(
      (client) =>
        client.request<ConfigPatchAck>("config.patch", {
          raw: '{"count":1,"enabled":true}',
          baseHash: "hash-1",
        }),
      { configWriteAck: (ack) => ack },
    );
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configForm).toEqual({ count: 1, enabled: true });
    runtimeConfig.dispose();
  });

  it("an independent write cannot flush a reconnect-paused draft during disposal", async () => {
    vi.useFakeTimers();
    const store = createConfigServerMock();
    const started = deferred<void>();
    const release = deferred<void>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch") {
        started.resolve();
        await release.promise;
        return store.request("config.set", {
          raw: '{"count":1,"enabled":true}',
          baseHash: "hash-1",
        });
      }
      return store.request(method, params);
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    publish(false);
    publish(true);
    await runtimeConfig.ensureLoaded();
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
    const mutation = runtimeConfig.runExternalMutation(
      (client) => client.request<ConfigPatchAck>("config.patch", { raw: '{"enabled":true}' }),
      { configWriteAck: (value) => value },
    );
    await started.promise;
    runtimeConfig.dispose();
    release.resolve();
    await mutation;
    await vi.advanceTimersByTimeAsync(0);
    expect(store.submissions).toHaveLength(1);
    await expect(store.request("config.get")).resolves.toMatchObject({
      config: { count: 1, enabled: true },
    });
  });

  it.each([false, true])(
    "a hashless no-op uses a fresh source revision and reports read failure separately (failure: %s)",
    async (failure) => {
      const source = { count: 1, enabled: true };
      const sourceRaw = '{\n  "count": 1,\n  "enabled": true\n}\n';
      const submissions: Array<{ raw: string; baseHash: string }> = [];
      let savedSnapshot: { config: Record<string, unknown>; raw: string; hash: string } | null =
        null;
      let reads = 0;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          reads += 1;
          if (reads === 1) {
            return { config: { count: 1 }, raw: '{"count":1}', hash: "hash-1", valid: true };
          }
          if (failure) {
            throw new Error("source read unavailable");
          }
          if (savedSnapshot) {
            return { ...savedSnapshot, valid: true };
          }
          return {
            config: { ...source, runtimeDefault: "resolved" },
            sourceConfig: source,
            raw: sourceRaw,
            hash: "hash-2",
            valid: true,
          };
        }
        if (method === "config.patch") {
          return { noop: true, config: { ...source, runtimeDefault: "resolved" } };
        }
        if (method === "config.set") {
          const submission = params as { raw: string; baseHash: string };
          submissions.push(submission);
          savedSnapshot = {
            config: JSON.parse(submission.raw),
            raw: submission.raw,
            hash: "hash-3",
          };
          return { config: savedSnapshot.config, hash: savedSnapshot.hash };
        }
        return {};
      });
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      await runtimeConfig.ensureLoaded();
      runtimeConfig.setRaw('{"count":2,"enabled":true}');
      const result = await runtimeConfig.runExternalMutation(
        (client) => client.request<ConfigPatchAck>("config.patch", { raw: '{"enabled":true}' }),
        { configWriteAck: (value) => value },
      );
      expect(result).toMatchObject({
        ok: true,
        value: { noop: true },
        refresh: failure ? { ok: false, error: "source read unavailable" } : { ok: true },
      });
      expect(runtimeConfig.state.configDraftBaseHash).toBe(failure ? "hash-1" : "hash-2");
      if (!failure) {
        expect(runtimeConfig.state.configSnapshot?.sourceConfig).toEqual(source);
        expect(runtimeConfig.state.configSnapshot?.raw).toBe(sourceRaw);
        await expect(runtimeConfig.save()).resolves.toBe(true);
        expect(submissions).toEqual([{ raw: '{"count":2,"enabled":true}', baseHash: "hash-2" }]);
      }
      runtimeConfig.resetDraft();
      runtimeConfig.dispose();
    },
  );

  it.each([
    { method: "config.set", dispose: false },
    { method: "config.set", dispose: true },
    { method: "config.patch", dispose: false },
    { method: "config.patch", dispose: true },
  ])(
    "independent $method retains its changes and the shared form edit (dispose: $dispose)",
    async ({ method, dispose }) => {
      vi.useFakeTimers();
      const store = createConfigServerMock();
      const started = deferred<void>();
      const release = deferred<void>();
      let independentWrite = true;
      const request = vi.fn(async (requestMethod: string, params?: unknown) => {
        if (requestMethod === method && independentWrite) {
          independentWrite = false;
          started.resolve();
          await release.promise;
          return store.request("config.set", {
            raw: '{"count":1,"enabled":true}',
            baseHash: "hash-1",
          });
        }
        return store.request(requestMethod, params);
      });
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      await runtimeConfig.ensureLoaded();
      const mutation = runtimeConfig.runExternalMutation(
        (client) =>
          client.request<ConfigPatchAck>(method, {
            raw: method === "config.set" ? '{"count":1,"enabled":true}' : '{"enabled":true}',
            baseHash: "hash-1",
          }),
        { configWriteAck: (value) => value },
      );
      await started.promise;
      runtimeConfig.patchForm(["count"], 2);
      if (dispose) {
        runtimeConfig.dispose();
      }
      release.resolve();
      await mutation;
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(store.submissions).toHaveLength(2);
      expect(store.submissions[1]?.baseHash).toBe("hash-2");
      await expect(store.request("config.get")).resolves.toMatchObject({
        config: { count: 2, enabled: true },
      });
      expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-3");
      runtimeConfig.dispose();
    },
  );

  it("a CAS patch no-op keeps the authored document and excludes runtime defaults from the next save", async () => {
    vi.useFakeTimers();
    const store = createConfigServerMock();
    const started = deferred<void>();
    const release = deferred<void>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch") {
        started.resolve();
        await release.promise;
        return { noop: true, config: { count: 1, runtimeDefault: "resolved" } };
      }
      return store.request(method, params);
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    const originalRaw = runtimeConfig.state.configRaw;
    const patch = runtimeConfig.patch({ raw: { count: 1 }, note: "Keep fixture count" });
    await started.promise;
    runtimeConfig.patchForm(["count"], 2);
    release.resolve();
    await expect(patch).resolves.toBe(true);
    expect(runtimeConfig.state.configRawOriginal).toBe(originalRaw);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(store.submissions).toHaveLength(1);
    expect(store.submissions[0]?.baseHash).toBe("hash-1");
    expect(JSON.parse(store.submissions[0]!.raw)).toEqual({ count: 2 });
    runtimeConfig.dispose();
  });

  it.each([
    { mode: "form", dispose: false },
    { mode: "form", dispose: true },
    { mode: "raw", dispose: false },
    { mode: "raw", dispose: true },
    { mode: "apply", dispose: false },
    { mode: "apply", dispose: true },
  ])(
    "config.set/config.apply adopts its revision after a raw keystroke ($mode save, dispose: $dispose)",
    async ({ mode, dispose }) => {
      vi.useFakeTimers();
      const { request, submissions, firstSet } = createDeferredSetServerMock();
      const { runtimeConfig } = createConfigCapabilityHarness(((method, params) =>
        request(
          method === "config.apply" ? "config.set" : method,
          params,
        )) as GatewayBrowserClient["request"]);
      await runtimeConfig.ensureLoaded();
      if (mode === "raw") {
        runtimeConfig.setRaw('{"count":2}');
      } else {
        runtimeConfig.patchForm(["count"], 2);
      }
      const saving =
        mode === "raw"
          ? runtimeConfig.save()
          : mode === "apply"
            ? runtimeConfig.apply()
            : undefined;
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      const raw = `${runtimeConfig.state.configRaw}\n`;
      runtimeConfig.setRaw(raw);
      if (dispose) {
        runtimeConfig.dispose();
      }
      firstSet.resolve({});
      await saving;
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimeConfig.state.configDraftBaseHash).not.toBe("hash-1");
      if (!dispose) {
        expect(runtimeConfig.state.configRaw).toBe(raw);
        await expect(runtimeConfig.save()).resolves.toBe(true);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(submissions).toHaveLength(2);
      expect(submissions[1]).toEqual({ raw, baseHash: "hash-2" });
      expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-3");
      runtimeConfig.dispose();
    },
  );

  it("config.patch adopts its revision and preserves an in-flight form edit", async () => {
    vi.useFakeTimers();
    const store = createConfigServerMock();
    const started = deferred<void>();
    const release = deferred<void>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch") {
        started.resolve();
        await release.promise;
        return store.request("config.set", {
          raw: '{"count":1,"enabled":true}',
          baseHash: "hash-1",
        });
      }
      return store.request(method, params);
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    const patch = runtimeConfig.patch({ raw: { enabled: true }, note: "Enable fixture" });
    await started.promise;
    runtimeConfig.patchForm(["count"], 2);
    release.resolve();
    await expect(patch).resolves.toBe(true);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(store.submissions[1]?.baseHash).toBe("hash-2");
    await expect(store.request("config.get")).resolves.toMatchObject({
      config: { count: 3, enabled: true },
    });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });
  it.each([
    {
      name: "missing external locale",
      canonical: { count: 2, locale: "fr" },
      raw: { count: 3 },
      form: false,
      saved: false,
    },
    {
      name: "incorporated external locale",
      canonical: { count: 2, locale: "fr" },
      raw: { count: 3, locale: "fr" },
      form: false,
      saved: true,
    },
    {
      name: "incorporated objects with reordered keys inside arrays",
      canonical: { count: 2, entries: [{ id: "first", enabled: true }] },
      raw: { entries: [{ enabled: true, id: "first" }], count: 3 },
      form: false,
      saved: true,
    },
    {
      name: "raw to form with unseen locale",
      canonical: { count: 2, locale: "fr" },
      raw: { count: 3 },
      form: true,
      saved: false,
    },
    {
      name: "external secret replaced an empty value",
      canonical: { count: 2, secret: "__OPENCLAW_REDACTED__" },
      raw: { count: 3, secret: "" },
      form: false,
      saved: false,
    },
    {
      name: "external secret replaced a null value",
      canonical: { count: 2, secret: "__OPENCLAW_REDACTED__" },
      raw: { count: 3, secret: null },
      form: false,
      saved: false,
    },
    {
      name: "external secret replaced an environment reference",
      canonical: { count: 2, secret: "__OPENCLAW_REDACTED__" },
      raw: { count: 3, secret: "${SYNTHETIC_SECRET}" },
      form: false,
      saved: false,
    },
    {
      name: "own redacted secret object",
      canonical: { count: 2, secret: "__OPENCLAW_REDACTED__" },
      raw: { count: 3, secret: { token: "synthetic-secret" } },
      form: false,
      saved: true,
    },
    {
      name: "own redacted secret array",
      canonical: { count: 2, secret: ["__OPENCLAW_REDACTED__"] },
      raw: { count: 3, secret: ["synthetic-secret", "new-secret"] },
      form: false,
      saved: true,
    },
  ])("config.set checks acknowledged content: $name", async ({ canonical, raw, form, saved }) => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock(canonical);
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    if ("secret" in raw) {
      runtimeConfig.patchForm(
        ["secret"],
        Array.isArray(raw.secret) ? raw.secret.slice(0, 1) : raw.secret,
      );
    }
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    runtimeConfig.setRaw(JSON.stringify(raw));
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
    if (form) {
      runtimeConfig.patchForm(["count"], 4);
    }
    await expect(runtimeConfig.save()).resolves.toBe(saved);
    expect(submissions).toHaveLength(saved ? 2 : 1);
    if (saved) {
      expect(submissions[1]?.baseHash).toBe("hash-2");
    } else {
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
    }
    runtimeConfig.resetDraft();
    runtimeConfig.dispose();
  });
});
