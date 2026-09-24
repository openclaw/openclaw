// @vitest-environment node
import {
  GatewayProtocolClient,
  isGatewayProtocolResponseError,
} from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
  createConfigServerMock,
} from "./config-test-harness.ts";
import type { RuntimeConfigCapability } from "./runtime-config-capability.ts";

const CONFLICT = "config changed since last load; re-run config.get and retry";
const capabilities = new Set<RuntimeConfigCapability>();

afterEach(() => {
  for (const capability of capabilities) {
    capability.setWritesSuspended(true);
    capability.dispose();
  }
  capabilities.clear();
});

function createRecoveryCapability(request: GatewayBrowserClient["request"]) {
  const harness = createConfigCapabilityHarness(request);
  capabilities.add(harness.runtimeConfig);
  return harness;
}

function createPatchServer() {
  const store = createConfigServerMock();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.patch" || method === "config.set") {
      const submission = params as { raw: string; baseHash: string };
      if (submission.baseHash !== store.currentHash()) {
        throw new GatewayRequestError({ code: "INVALID_REQUEST", message: CONFLICT });
      }
      if (method === "config.patch") {
        const snapshot = (await store.request("config.get")) as ConfigSnapshot;
        // These scenarios patch separate top-level values; the existing store
        // still owns persisted bytes, revision hashes, and applied revisions.
        const config = {
          ...snapshot.config,
          ...(JSON.parse(submission.raw) as Record<string, unknown>),
        };
        if (JSON.stringify(config) === JSON.stringify(snapshot.config)) {
          return { noop: true, config };
        }
        await store.request("config.set", {
          raw: JSON.stringify(config),
          baseHash: submission.baseHash,
        });
        return { config, hash: store.currentHash() };
      }
    }
    return store.request(method, params);
  });
  return { store, request };
}

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
  const transport = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (handlers) => ({
      isOpen: () => true,
      close: () => undefined,
      send: (data) => {
        const frame = JSON.parse(data) as (typeof frames)[number];
        frames.push(frame);
        void server.request(frame.method, frame.params).then(
          async (payload) => {
            const persistedFailure = frame.method === "config.patch" && failAfterPersist;
            if (persistedFailure) {
              failAfterPersist = false;
              await options.beforeFailure?.();
            }
            handlers.message(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: !persistedFailure,
                ...(persistedFailure
                  ? {
                      error: {
                        code: "UNAVAILABLE",
                        details: options.failureDetails
                          ? options.failureDetails(payload)
                          : { persistedConfig: payload },
                        message:
                          "config.patch persisted but was not applied to the active Gateway (failed); run config.get, then use config.apply to reapply the saved config or restart the Gateway",
                      },
                    }
                  : { payload }),
              }),
            );
          },
          (error: unknown) =>
            handlers.message(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: false,
                error: {
                  code: "INVALID_REQUEST",
                  message: error instanceof Error ? error.message : String(error),
                },
              }),
            ),
        );
      },
    }),
    createRequestId: () => `patch-recovery-${++requestId}`,
    createRequestError: (error) =>
      new GatewayRequestError({
        code: error.code ?? "UNAVAILABLE",
        details: error.details,
        message: error.message ?? "request failed",
      }),
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: false, notify: false }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  transport.start();
  const request: GatewayBrowserClient["request"] = async (method, params) => {
    try {
      return await transport.request(method, params);
    } catch (error) {
      responseErrors.push(error);
      throw error;
    }
  };
  return { ...server, transport, request, frames, responseErrors };
}

describe("config patch recovery", () => {
  it.each([
    {},
    { persistedConfig: { hash: "", config: { count: 1, enabled: false } } },
    { persistedConfig: { hash: "hash-2", config: [] } },
    ...(["partial", "complete"] as const).flatMap((publication) =>
      ["restored", "unknown", "not-restored"].map((rollbackStatus) => ({
        publication,
        rollbackStatus,
        persistedConfig: { hash: "hash-2", config: { count: 1, enabled: false } },
      })),
    ),
  ])("does not adopt an unavailable, invalid, or rolled-back receipt: %j", async (details) => {
    vi.useFakeTimers();
    const server = createPersistedFailureTransport({ failureDetails: () => details });
    const { runtimeConfig } = createRecoveryCapability(server.request);
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.setRaw('{ "count": 7 }\n');
      await expect(runtimeConfig.patch({ raw: { enabled: false }, note: "Disable" })).resolves.toBe(
        false,
      );
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-1");
      expect(runtimeConfig.state.configNeedsApply).toBe(false);
      expect(runtimeConfig.state.configRaw).toBe('{ "count": 7 }\n');
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    } finally {
      runtimeConfig.setWritesSuspended(true);
      server.transport.stop();
    }
  });

  it("keeps a foreign write's CAS conflict after adopting its own persisted receipt", async () => {
    vi.useFakeTimers();
    const server = createPersistedFailureTransport();
    const { runtimeConfig } = createRecoveryCapability(server.request);
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.setRaw('{ "count": 7 }\n');
      await runtimeConfig.patch({ raw: { enabled: false }, note: "Disable" });
      await server.store.request("config.set", {
        raw: '{"count":3,"enabled":true}',
        baseHash: "hash-2",
      });
      await expect(runtimeConfig.retry()).resolves.toBe(false);
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
      expect(runtimeConfig.state.configRaw).toBe('{ "count": 7 }\n');
      expect(server.store.submissions).toHaveLength(2);
      await expect(server.store.request("config.get")).resolves.toMatchObject({
        config: { count: 3, enabled: true },
      });
    } finally {
      runtimeConfig.setWritesSuspended(true);
      server.transport.stop();
    }
  });

  it.each(["disconnect", "replace"] as const)(
    "ignores a persisted receipt after %s",
    async (change) => {
      vi.useFakeTimers();
      const persisted = deferred();
      const response = deferred();
      const server = createPersistedFailureTransport({
        beforeFailure: async () => {
          persisted.resolve();
          await response.promise;
        },
      });
      const { runtimeConfig, publish } = createRecoveryCapability(server.request);
      let replacement: ReturnType<typeof createPersistedFailureTransport> | undefined;
      try {
        await runtimeConfig.ensureLoaded();
        runtimeConfig.setRaw('{ "count": 7 }\n');
        const patch = runtimeConfig.patch({ raw: { enabled: false }, note: "Disable" });
        await persisted.promise;
        publish(false);
        if (change === "replace") {
          replacement = createPersistedFailureTransport();
          const replacementCapability = createRecoveryCapability(replacement.request);
          const client = replacementCapability.runtimeConfig.state.client;
          if (!client) {
            throw new Error("replacement fixture must have a client");
          }
          publish(true, client);
          await runtimeConfig.refresh();
        }
        const before = runtimeConfig.state.configSnapshot;
        response.resolve();
        await expect(patch).resolves.toBe(false);
        expect(runtimeConfig.state.configSnapshot).toBe(before);
        expect(runtimeConfig.state.configNeedsApply).toBe(false);
        expect(runtimeConfig.state.configRaw).toBe('{ "count": 7 }\n');
      } finally {
        runtimeConfig.setWritesSuspended(true);
        server.transport.stop();
        replacement?.transport.stop();
      }
    },
  );

  it("does not treat a locally constructed request error as a persistence receipt", async () => {
    vi.useFakeTimers();
    const server = createPersistedFailureTransport();
    const request: GatewayBrowserClient["request"] = async (method, params) => {
      if (method === "config.patch") {
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Local failure",
          details: {
            persistedConfig: { hash: "unconfirmed", config: { enabled: false } },
          },
        });
      }
      return server.request(method, params);
    };
    const { runtimeConfig } = createRecoveryCapability(request);
    await runtimeConfig.ensureLoaded();
    await expect(runtimeConfig.patch({ raw: { enabled: false }, note: "Disable" })).resolves.toBe(
      false,
    );
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-1");
    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    expect(server.store.submissions).toHaveLength(0);
    server.transport.stop();
  });

  it.each(["raw", "form"] as const)(
    "adopts a persisted patch revision while retaining an unrelated %s draft",
    async (mode) => {
      vi.useFakeTimers();
      const { store, transport, request, frames, responseErrors } =
        createPersistedFailureTransport();
      const { runtimeConfig, publish } = createRecoveryCapability(request);
      try {
        await runtimeConfig.ensureLoaded();
        if (mode === "raw") {
          runtimeConfig.setRaw('{ "count": 7 }\n');
        } else {
          runtimeConfig.patchForm(["count"], 7);
          publish(false);
          publish(true);
          await runtimeConfig.refresh();
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
        }
        await expect(
          runtimeConfig.patch({ raw: { enabled: false }, note: "Disable feature" }),
        ).resolves.toBe(false);
        expect(responseErrors[0]).toBeInstanceOf(GatewayRequestError);
        expect(isGatewayProtocolResponseError(responseErrors[0])).toBe(true);
        if (mode === "raw") {
          expect(runtimeConfig.state.configRaw).toBe('{ "count": 7 }\n');
        } else {
          expect(runtimeConfig.state.configForm).toEqual({ count: 7, enabled: false });
        }
        expect(runtimeConfig.state.configAutoSaveStatus).toBe(
          mode === "raw" ? "conflict" : "error",
        );
        if (mode === "form") {
          expect(runtimeConfig.state.lastError).toContain("was not applied");
        }
        expect(runtimeConfig.state.configFormDirty).toBe(true);
        await expect(store.request("config.get")).resolves.toMatchObject({
          config: { count: 1, enabled: false },
          hash: "hash-2",
        });

        const recovered = await runtimeConfig.retry();
        expect(runtimeConfig.state.configFormDirty).toBe(true);
        expect(frames.filter((frame) => frame.method === "config.set")).toHaveLength(0);
        const observed = {
          recovered,
          revision: runtimeConfig.state.configSnapshot?.hash,
          needsApply: runtimeConfig.state.configNeedsApply,
          status: runtimeConfig.state.configAutoSaveStatus,
          lastError: runtimeConfig.state.lastError,
          patchBases: frames
            .filter((frame) => frame.method === "config.patch")
            .map((frame) => (frame.params as { baseHash: string }).baseHash),
        };
        expect(observed, JSON.stringify(observed)).toMatchObject({
          recovered: true,
          revision: "hash-2",
          needsApply: true,
          patchBases: ["hash-1", "hash-2"],
        });
        if (mode === "raw") {
          // Whole-file raw text still omits the independently committed field.
          expect(runtimeConfig.state.configRaw).toBe('{ "count": 7 }\n');
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
        } else {
          expect(runtimeConfig.state.configForm).toEqual({ count: 7, enabled: false });
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
        }
        expect(store.submissions).toHaveLength(1);
      } finally {
        runtimeConfig.setWritesSuspended(true);
        runtimeConfig.dispose();
        capabilities.delete(runtimeConfig);
        transport.stop();
      }
    },
  );

  it("restores the paused draft's Save prompt after a rejected patch recovers", async () => {
    vi.useFakeTimers();
    const server = createPatchServer();
    let rejectPatch = true;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch" && rejectPatch) {
        throw new Error("permission denied");
      }
      return server.request(method, params);
    });
    const { runtimeConfig, publish } = createRecoveryCapability(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 7);
    publish(false);
    publish(true);
    await runtimeConfig.refresh();
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");

    await expect(
      runtimeConfig.patch({ raw: { enabled: false }, note: "Disable feature" }),
    ).resolves.toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    rejectPatch = false;
    await expect(runtimeConfig.retry()).resolves.toBe(true);

    expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configForm).toEqual({ count: 7, enabled: false });
    expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(0);
    await expect(server.store.request("config.get")).resolves.toMatchObject({
      config: { count: 1, enabled: false },
    });
  });

  it("retries the rejected patch and resumes ordinary form autosave", async () => {
    vi.useFakeTimers();
    const server = createPatchServer();
    let rejectPatch = true;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch" && rejectPatch) {
        throw new Error("permission denied");
      }
      return server.request(method, params);
    });
    const { runtimeConfig } = createRecoveryCapability(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");

    const patch = {
      raw: { gateway: { controlUi: { sessionObserver: false } } },
      note: "Disable session observer",
    };
    await expect(runtimeConfig.patch(patch)).resolves.toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    expect(runtimeConfig.state.lastError).toBe("permission denied");
    expect(runtimeConfig.state.configFormDirty).toBe(false);

    rejectPatch = false;
    await expect(runtimeConfig.retry()).resolves.toBe(true);
    expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
    await expect(server.store.request("config.get")).resolves.toMatchObject({
      config: { count: 2, gateway: { controlUi: { sessionObserver: false } } },
    });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    expect(runtimeConfig.state.lastError).toBeNull();

    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    await expect(server.store.request("config.get")).resolves.toMatchObject({
      config: { count: 3, gateway: { controlUi: { sessionObserver: false } } },
    });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
  });

  it("clears a scalar patch conflict after refresh and a successful Workshop retry", async () => {
    const server = createPatchServer();
    const { runtimeConfig } = createRecoveryCapability(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    await server.store.request("config.set", { raw: '{"count":7}', baseHash: "hash-1" });
    const patch = {
      raw: { skills: { workshop: { autonomous: { mode: "off" } } } },
      note: "Disable Skill Workshop self-learning",
    };

    await expect(runtimeConfig.patch(patch)).resolves.toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
    expect(runtimeConfig.state.lastError).toContain(CONFLICT);
    await runtimeConfig.refresh();
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    expect(runtimeConfig.state.lastError).toBeNull();
    await expect(runtimeConfig.patch(patch)).resolves.toBe(true);

    await expect(server.store.request("config.get")).resolves.toMatchObject({
      config: { count: 7, skills: { workshop: { autonomous: { mode: "off" } } } },
    });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    expect(runtimeConfig.state.lastError).toBeNull();
  });

  it.each(["raw", "form"] as const)(
    "preserves an unrelated %s draft conflict through refresh and a successful patch",
    async (mode) => {
      vi.useFakeTimers();
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
      const { runtimeConfig } = createRecoveryCapability(
        request as GatewayBrowserClient["request"],
      );
      await runtimeConfig.ensureLoaded();
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
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
      await runtimeConfig.refresh();
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
      expect(runtimeConfig.state.lastError).toContain(CONFLICT);

      const patch = runtimeConfig.patch({ raw: { enabled: false }, note: "Disable feature" });
      await patchStarted.promise;
      editCount(3);
      const draftRaw = runtimeConfig.state.configRaw;
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      releasePatch.resolve();
      await expect(patch).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

      expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
      expect(runtimeConfig.state.lastError).toContain(CONFLICT);
      expect(runtimeConfig.state.configFormDirty).toBe(true);
      expect(runtimeConfig.state.configFormMode).toBe(mode);
      expect(runtimeConfig.state.configRaw).toBe(draftRaw);
      expect(runtimeConfig.state.configFormOriginal).toEqual({ count: 1 });
      expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-3");
      expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
      await expect(server.store.request("config.get")).resolves.toMatchObject({
        config: { count: 9, enabled: false },
      });
    },
  );

  it("offers reload when the patch snapshot has no hash and sends no write", async () => {
    const server = createPatchServer();
    const request = vi.fn(async (method: string, params?: unknown) => {
      const response = await server.request(method, params);
      return method === "config.get" ? { ...response, hash: null } : response;
    });
    const { runtimeConfig } = createRecoveryCapability(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    await expect(runtimeConfig.patch({ raw: { count: 2 }, note: "Change count" })).resolves.toBe(
      false,
    );

    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
    expect(runtimeConfig.state.lastError).toContain("Config hash missing");
    expect(request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(0);
    await expect(server.store.request("config.get")).resolves.toMatchObject({
      config: { count: 1 },
    });
  });

  it("keeps the current failure and retry intent when an old connection rejects late", async () => {
    const server = createPatchServer();
    const stalePatch = deferred<unknown>();
    const patchStarted = deferred();
    let patchCount = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch") {
        patchCount += 1;
        if (patchCount === 1) {
          patchStarted.resolve();
          return stalePatch.promise;
        }
        if (patchCount === 2) {
          throw new Error("current patch rejected");
        }
      }
      return server.request(method, params);
    });
    const { runtimeConfig, publish } = createRecoveryCapability(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    const oldWrite = runtimeConfig.patch({ raw: { count: 2 }, note: "Old edit" });
    await patchStarted.promise;
    publish(false);
    publish(true);
    await runtimeConfig.refresh();
    await expect(runtimeConfig.patch({ raw: { count: 3 }, note: "Current edit" })).resolves.toBe(
      false,
    );

    stalePatch.reject(new Error("old patch rejected"));
    await expect(oldWrite).resolves.toBe(false);
    expect(runtimeConfig.state.lastError).toBe("current patch rejected");
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    await expect(runtimeConfig.retry()).resolves.toBe(true);

    await expect(server.store.request("config.get")).resolves.toMatchObject({
      config: { count: 3 },
    });
    expect(runtimeConfig.state.lastError).toBeNull();
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
  });

  it("retires a failed patch after reconnect so a later retry only saves the current draft", async () => {
    vi.useFakeTimers();
    const server = createPatchServer();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch") {
        throw new Error("old connection rejected the patch");
      }
      return server.request(method, params);
    });
    const { runtimeConfig, publish } = createRecoveryCapability(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    await expect(runtimeConfig.patch({ raw: { count: 2 }, note: "Old edit" })).resolves.toBe(false);
    publish(false);
    publish(true);
    await runtimeConfig.refresh();
    runtimeConfig.patchForm(["count"], 4);

    await expect(runtimeConfig.retry()).resolves.toBe(true);

    await expect(server.store.request("config.get")).resolves.toMatchObject({
      config: { count: 4 },
    });
    expect(request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
  });

  it("rechecks caller access on retry without falling through to a full save", async () => {
    const server = createPatchServer();
    let rejectPatch = true;
    let canDispatch = true;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch" && rejectPatch) {
        throw new Error("write unavailable");
      }
      return server.request(method, params);
    });
    const { runtimeConfig } = createRecoveryCapability(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();
    await expect(
      runtimeConfig.patch({
        raw: { count: 2 },
        note: "Change count",
        canDispatch: () => canDispatch,
      }),
    ).resolves.toBe(false);

    rejectPatch = false;
    canDispatch = false;
    await expect(runtimeConfig.retry()).resolves.toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "config.patch")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(0);
    await expect(server.store.request("config.get")).resolves.toMatchObject({
      config: { count: 1 },
    });

    canDispatch = true;
    await expect(runtimeConfig.retry()).resolves.toBe(true);
    await expect(server.store.request("config.get")).resolves.toMatchObject({
      config: { count: 2 },
    });
  });

  it("retries the latest failed builder against the refreshed snapshot", async () => {
    const server = createPatchServer();
    let rejectPatch = true;
    let canBuild = false;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch" && rejectPatch) {
        throw new Error("older patch rejected");
      }
      return server.request(method, params);
    });
    const { runtimeConfig } = createRecoveryCapability(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();
    await expect(runtimeConfig.patch({ raw: { count: 2 }, note: "Old edit" })).resolves.toBe(false);
    await expect(
      runtimeConfig.patchFromSnapshot((config) =>
        canBuild
          ? { options: { raw: { count: 3, selectedFrom: config.count }, note: "Current edit" } }
          : { error: "Selection unavailable" },
      ),
    ).resolves.toBe(false);
    expect(runtimeConfig.state.lastError).toBe("Selection unavailable");
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");

    rejectPatch = false;
    canBuild = true;
    await server.store.request("config.set", { raw: '{"count":7}', baseHash: "hash-1" });
    await runtimeConfig.refresh();
    await expect(runtimeConfig.retry()).resolves.toBe(true);

    await expect(server.store.request("config.get")).resolves.toMatchObject({
      config: { count: 3, selectedFrom: 7 },
    });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    expect(runtimeConfig.state.lastError).toBeNull();
  });

  it("keeps a rejected patch and its explanation visible through background refresh", async () => {
    vi.useFakeTimers();
    const server = createPatchServer();
    let rejectPatch = false;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch" && rejectPatch) {
        throw new Error("permission denied");
      }
      return server.request(method, params);
    });
    const { runtimeConfig } = createRecoveryCapability(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();
    await expect(runtimeConfig.patch({ raw: { count: 2 }, note: "First edit" })).resolves.toBe(
      true,
    );
    rejectPatch = true;
    await expect(runtimeConfig.patch({ raw: { count: 3 }, note: "Second edit" })).resolves.toBe(
      false,
    );

    await vi.advanceTimersByTimeAsync(250);

    expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(2);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    expect(runtimeConfig.state.lastError).toBe("permission denied");
    rejectPatch = false;
    await expect(runtimeConfig.retry()).resolves.toBe(true);
    await expect(server.store.request("config.get")).resolves.toMatchObject({
      config: { count: 3 },
    });
  });
});
