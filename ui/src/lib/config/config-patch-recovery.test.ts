// @vitest-environment node

import { isGatewayProtocolResponseError } from "@openclaw/gateway-client/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  expectFeedback,
  configServerTransport,
  expectStoredConfig,
  createPatchServer,
  configHarness,
  loadedConfig,
  expectCalls,
} from "./config-suite.test-support.ts";
import { CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS } from "./config-test-harness.ts";

const CONFLICT = "config changed since last load; re-run config.get and retry";
beforeEach(() => vi.useFakeTimers());
const persistedConfig = { hash: "hash-2", config: { count: 1, enabled: false } };
const disableFeature = { raw: { enabled: false }, note: "Disable feature" };
const createRecoveryCapability = (request: Parameters<typeof configHarness>[0]) =>
  loadedConfig(request, true);

function createPersistedFailureTransport(
  options: {
    failureDetails?: (ack: unknown) => unknown;
    beforeFailure?: () => Promise<void>;
  } = {},
) {
  const server = createPatchServer();
  let failAfterPersist = true;
  let requestId = 0;
  const frames: Array<{ id: string; method: string; params: unknown }> = [];
  const responseErrors: unknown[] = [];
  const transport = configServerTransport(
    (frame) => {
      frames.push(frame);
      return server.request(frame.method, frame.params).then(
        async (payload) => {
          if (frame.method !== "config.patch" || !failAfterPersist) {
            return { ok: true, payload };
          }
          failAfterPersist = false;
          await options.beforeFailure?.();
          return {
            ok: false,
            error: {
              code: "UNAVAILABLE",
              details: options.failureDetails
                ? options.failureDetails(payload)
                : { persistedConfig: payload },
              message: "config.patch persisted but was not applied to the active Gateway",
            },
          };
        },
        (error: unknown) => ({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    },
    () => `patch-recovery-${++requestId}`,
  );
  transport.start();
  const request: GatewayBrowserClient["request"] = <T = unknown>(
    method: string,
    params?: unknown,
  ) =>
    transport.request<T>(method, params).catch((error: unknown) => {
      responseErrors.push(error);
      throw error;
    });
  return { ...server, transport, request, frames, responseErrors };
}

describe("config patch recovery", () => {
  it.each([
    [true, { persistedConfig: { hash: "unconfirmed", config: { enabled: false } } }],
    ...[
      {},
      { persistedConfig: { hash: "", config: { count: 1, enabled: false } } },
      { persistedConfig: { hash: "hash-2", config: [] } },
      { publication: "partial", rollbackStatus: "restored", persistedConfig },
      { publication: "complete", rollbackStatus: "unknown", persistedConfig },
    ].map((details) => [false, details] as const),
  ] as const)(
    "rejects an untrusted or invalid persistence receipt (local: %s): %j",
    async (local, details) => {
      const server = createPersistedFailureTransport({ failureDetails: () => details });
      const request: GatewayBrowserClient["request"] = async (method, params) => {
        if (local && method === "config.patch") {
          throw new GatewayRequestError({ code: "UNAVAILABLE", message: "Local failure", details });
        }
        return server.request(method, params);
      };
      const { runtimeConfig, state } = await createRecoveryCapability(request);
      runtimeConfig.setRaw('{ "count": 7 }\n');
      await expect(runtimeConfig.patch(disableFeature)).resolves.toBe(false);
      expect(state.configSnapshot?.hash).toBe("hash-1");
      expect(state).toMatchObject({
        configNeedsApply: false,
        configRaw: '{ "count": 7 }\n',
        configAutoSaveStatus: "error",
      });
      if (local) {
        expect(server.store.submissions).toHaveLength(0);
      }
    },
  );

  it.each(["disconnect", "replace"] as const)(
    "ignores a persisted receipt after %s",
    async (change) => {
      const persisted = deferred();
      const response = deferred();
      const server = createPersistedFailureTransport({
        beforeFailure: async () => {
          persisted.resolve();
          await response.promise;
        },
      });
      const { runtimeConfig, state, publish } = await createRecoveryCapability(server.request);
      runtimeConfig.setRaw('{ "count": 7 }\n');
      const patch = runtimeConfig.patch(disableFeature);
      await persisted.promise;
      publish(false);
      if (change === "replace") {
        const replacement = createPersistedFailureTransport();
        const client = configHarness(replacement.request, true).state.client;
        if (!client) {
          throw new Error("replacement fixture must have a client");
        }
        publish(true, client);
        await runtimeConfig.refresh();
      }
      const before = state.configSnapshot;
      response.resolve();
      await expect(patch).resolves.toBe(false);
      expect(state.configSnapshot).toBe(before);
      expect(state).toMatchObject({
        configNeedsApply: false,
        configRaw: '{ "count": 7 }\n',
      });
    },
  );

  it.each([
    { mode: "raw", foreign: false },
    { mode: "form", foreign: false },
    { mode: "raw", foreign: true },
  ] as const)(
    "adopts a persisted patch without overwriting a $mode draft or foreign write ($foreign)",
    async ({ mode, foreign }) => {
      const { store, request, frames, responseErrors } = createPersistedFailureTransport();
      const { runtimeConfig, state, publish } = await createRecoveryCapability(request);
      if (mode === "raw") {
        runtimeConfig.setRaw('{ "count": 7 }\n');
      } else {
        runtimeConfig.patchForm(["count"], 7);
        publish(false);
        publish(true);
        await runtimeConfig.refresh();
        expect(state.configAutoSaveStatus).toBe("paused");
      }
      await expect(runtimeConfig.patch(disableFeature)).resolves.toBe(false);
      expect(responseErrors[0]).toBeInstanceOf(GatewayRequestError);
      expect(isGatewayProtocolResponseError(responseErrors[0])).toBe(true);
      if (mode === "raw") {
        expect(state.configRaw).toBe('{ "count": 7 }\n');
      } else {
        expect(state.configForm).toEqual({ count: 7, enabled: false });
      }
      expect(state.configAutoSaveStatus).toBe(mode === "raw" ? "conflict" : "error");
      if (mode === "form") {
        expect(state.lastError).toContain("was not applied");
      }
      expect(state.configFormDirty).toBe(true);
      await expect(store.request("config.get")).resolves.toMatchObject({
        config: { count: 1, enabled: false },
        hash: "hash-2",
      });

      if (foreign) {
        await store.request("config.set", {
          raw: '{"count":3,"enabled":true}',
          baseHash: "hash-2",
        });
        await expect(runtimeConfig.retry()).resolves.toBe(false);
        expect(state).toMatchObject({
          configAutoSaveStatus: "conflict",
          configRaw: '{ "count": 7 }\n',
        });
        expect(store.submissions).toHaveLength(2);
        await expectStoredConfig(store, { count: 3, enabled: true });
        return;
      }
      await expect(runtimeConfig.retry()).resolves.toBe(true);
      expect(state.configFormDirty).toBe(true);
      expect(frames.filter((frame) => frame.method === "config.set")).toHaveLength(0);
      expect(state.configSnapshot?.hash).toBe("hash-2");
      expect(state.configNeedsApply).toBe(true);
      expect(
        frames
          .filter((frame) => frame.method === "config.patch")
          .map((frame) => (frame.params as { baseHash: string }).baseHash),
      ).toEqual(["hash-1", "hash-2"]);
      if (mode === "raw") {
        // Whole-file raw text still omits the independently committed field.
        expect(state).toMatchObject({
          configRaw: '{ "count": 7 }\n',
          configAutoSaveStatus: "conflict",
        });
      } else {
        expect(state.configForm).toEqual({ count: 7, enabled: false });
        expect(state.configAutoSaveStatus).toBe("paused");
      }
      expect(store.submissions).toHaveLength(1);
    },
  );

  it.each(["paused", "autosave", "background"] as const)(
    "recovers a rejected patch without losing %s feedback",
    async (scenario) => {
      const server = createPatchServer();
      let rejectPatch = false;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.patch" && rejectPatch) {
          throw new Error("permission denied");
        }
        return server.request(method, params);
      });
      const { runtimeConfig, state, publish } = await createRecoveryCapability(request);
      if (scenario === "paused") {
        runtimeConfig.patchForm(["count"], 7);
        publish(false);
        publish(true);
        await runtimeConfig.refresh();
        expect(state.configAutoSaveStatus).toBe("paused");
      } else if (scenario === "autosave") {
        runtimeConfig.patchForm(["count"], 2);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        expect(state.configAutoSaveStatus).toBe("saved");
      } else {
        await expect(runtimeConfig.patch({ raw: { count: 2 }, note: "First edit" })).resolves.toBe(
          true,
        );
      }
      const raw =
        scenario === "paused"
          ? { enabled: false }
          : scenario === "autosave"
            ? { gateway: { controlUi: { sessionObserver: false } } }
            : { count: 3 };
      rejectPatch = true;
      await expect(runtimeConfig.patch({ raw, note: "Second edit" })).resolves.toBe(false);
      expect(state).toMatchObject({
        configAutoSaveStatus: "error",
        lastError: "permission denied",
        configFormDirty: scenario === "paused",
      });
      if (scenario === "background") {
        await vi.advanceTimersByTimeAsync(250);
        expectCalls(request, "config.get", 2);
        expectFeedback(state, "error", "permission denied");
      }
      rejectPatch = false;
      await expect(runtimeConfig.retry()).resolves.toBe(true);
      const config = { count: scenario === "paused" ? 1 : 2, ...raw };
      await expect(server.store.request("config.get")).resolves.toMatchObject({ config });
      expect(state.configAutoSaveStatus).toBe(scenario === "paused" ? "paused" : "saved");
      if (scenario === "paused") {
        expect(state.configFormDirty).toBe(true);
        expect(state.configForm).toEqual({ count: 7, enabled: false });
      } else {
        expect(state.lastError).toBeNull();
      }
      if (scenario !== "background") {
        expectCalls(request, "config.set", scenario === "autosave" ? 1 : 0);
      }
      if (scenario === "autosave") {
        runtimeConfig.patchForm(["count"], 3);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        await expectStoredConfig(server.store, { ...config, count: 3 });
        expect(state).toMatchObject({ configFormDirty: false, configAutoSaveStatus: "saved" });
      }
    },
  );

  it("clears a scalar patch conflict after refresh and a successful Workshop retry", async () => {
    const server = createPatchServer();
    const { runtimeConfig, state } = await createRecoveryCapability(server.request);
    await server.store.request("config.set", { raw: '{"count":7}', baseHash: "hash-1" });
    const patch = {
      raw: { skills: { workshop: { autonomous: { mode: "off" } } } },
      note: "Disable Skill Workshop self-learning",
    };

    await expect(runtimeConfig.patch(patch)).resolves.toBe(false);
    expectFeedback(state, "conflict", expect.stringContaining(CONFLICT));
    await runtimeConfig.refresh();
    expectFeedback(state, "idle", null);
    await expect(runtimeConfig.patch(patch)).resolves.toBe(true);

    await expectStoredConfig(server.store, {
      count: 7,
      skills: { workshop: { autonomous: { mode: "off" } } },
    });
    expectFeedback(state, "saved", null);
  });

  it.each(["raw", "form"] as const)(
    "preserves an unrelated %s draft conflict through refresh and a successful patch",
    async (mode) => {
      const server = createPatchServer();
      const patchStarted = deferred();
      const releasePatch = deferred();
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.patch") {
          patchStarted.resolve();
          await releasePatch.promise;
        }
        return server.request(method, params);
      });
      const { runtimeConfig, state } = await createRecoveryCapability(request);
      const editCount = (count: number) => {
        if (mode === "raw") {
          runtimeConfig.setRaw(`{ "count": ${count} }\n`);
        } else {
          runtimeConfig.patchForm(["count"], count);
        }
      };
      editCount(2);
      await server.store.request("config.set", { raw: '{"count":9}', baseHash: "hash-1" });
      await expect(runtimeConfig.save()).resolves.toBe(false);
      expect(state.configAutoSaveStatus).toBe("conflict");
      await runtimeConfig.refresh();
      expectFeedback(state, "conflict", expect.stringContaining(CONFLICT));

      const patch = runtimeConfig.patch(disableFeature);
      await patchStarted.promise;
      editCount(3);
      const draftRaw = state.configRaw;
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      releasePatch.resolve();
      await expect(patch).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

      expect(state).toMatchObject({
        configAutoSaveStatus: "conflict",
        lastError: expect.stringContaining(CONFLICT),
        configFormDirty: true,
        configFormMode: mode,
        configRaw: draftRaw,
      });
      expect(state.configFormOriginal).toEqual({ count: 1 });
      expect(state.configDraftBaseHash).toBe("hash-3");
      expectCalls(request, "config.set", 1);
      await expectStoredConfig(server.store, { count: 9, enabled: false });
    },
  );

  it("offers reload when the patch snapshot has no hash and sends no write", async () => {
    const server = createPatchServer();
    const request = vi.fn(async (method: string, params?: unknown) => {
      const response = await server.request(method, params);
      return method === "config.get" ? { ...response, hash: null } : response;
    });
    const { runtimeConfig, state } = await createRecoveryCapability(request);

    await expect(runtimeConfig.patch({ raw: { count: 2 }, note: "Change count" })).resolves.toBe(
      false,
    );

    expectFeedback(state, "conflict", expect.stringContaining("Config hash missing"));
    expectCalls(request, "config.patch", 0);
    await expectStoredConfig(server.store, { count: 1 });
  });

  it.each(["rejected", "pending"] as const)(
    "retires the old connection's %s patch without replacing current retry intent",
    async (settlement) => {
      const server = createPatchServer();
      const stalePatch = deferred<unknown>();
      const patchStarted = deferred();
      let patchCount = 0;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.patch") {
          if (++patchCount === 1) {
            patchStarted.resolve();
            if (settlement === "pending") {
              return stalePatch.promise;
            }
            throw new Error("old connection rejected the patch");
          }
          if (patchCount === 2) {
            throw new Error("current patch rejected");
          }
        }
        return server.request(method, params);
      });
      const { runtimeConfig, state, publish } = await createRecoveryCapability(request);
      const oldWrite = runtimeConfig.patch({ raw: { count: 2 }, note: "Old edit" });
      await patchStarted.promise;
      if (settlement === "rejected") {
        await expect(oldWrite).resolves.toBe(false);
      }
      publish(false);
      publish(true);
      await runtimeConfig.refresh();
      if (settlement === "pending") {
        await expect(
          runtimeConfig.patch({ raw: { count: 3 }, note: "Current edit" }),
        ).resolves.toBe(false);
        stalePatch.reject(new Error("old patch rejected"));
        await expect(oldWrite).resolves.toBe(false);
        expectFeedback(state, "error", "current patch rejected");
      } else {
        runtimeConfig.patchForm(["count"], 4);
      }
      await expect(runtimeConfig.retry()).resolves.toBe(true);
      await expectStoredConfig(server.store, { count: settlement === "pending" ? 3 : 4 });
      expectCalls(request, "config.patch", settlement === "pending" ? 3 : 1);
      expectFeedback(state, "saved", null);
    },
  );

  it.each(["access", "builder"] as const)(
    "rechecks the current %s before retrying a rejected patch",
    async (guard) => {
      const server = createPatchServer();
      let rejectPatch = true;
      let allowed = false;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.patch" && rejectPatch) {
          throw new Error("write unavailable");
        }
        return server.request(method, params);
      });
      const { runtimeConfig, state } = await createRecoveryCapability(request);
      await expect(
        runtimeConfig.patch({
          raw: { count: 2 },
          note: "Old edit",
          ...(guard === "access" ? { canDispatch: () => rejectPatch || allowed } : {}),
        }),
      ).resolves.toBe(false);
      rejectPatch = false;
      if (guard === "access") {
        await expect(runtimeConfig.retry()).resolves.toBe(false);
        expectCalls(request, "config.patch", 1);
        expectCalls(request, "config.set", 0);
        await expectStoredConfig(server.store, { count: 1 });
      } else {
        await expect(
          runtimeConfig.patchFromSnapshot((config) =>
            allowed
              ? { options: { raw: { count: 3, selectedFrom: config.count }, note: "Current edit" } }
              : { error: "Selection unavailable" },
          ),
        ).resolves.toBe(false);
        expectFeedback(state, "error", "Selection unavailable");
        await server.store.request("config.set", { raw: '{"count":7}', baseHash: "hash-1" });
        await runtimeConfig.refresh();
      }
      allowed = true;
      await expect(runtimeConfig.retry()).resolves.toBe(true);
      await expect(server.store.request("config.get")).resolves.toMatchObject({
        config: guard === "access" ? { count: 2 } : { count: 3, selectedFrom: 7 },
      });
      expectFeedback(state, "saved", null);
    },
  );
});
