/* @vitest-environment jsdom */

import { GatewayProtocolClient } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_APPEARANCE_PREFERENCE_KEYS } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
  createDeferredSetServerMock,
  createConfigServerMock,
} from "../lib/config/config-test-harness.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createProfileAppearanceGateway } from "./app-shell-gateway.test-support.ts";
import { UI_NAVIGATION_PREFERENCE_KEYS } from "./server-prefs-state.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

function createShellConfig(request: GatewayBrowserClient["request"]) {
  const harness = createConfigCapabilityHarness(request);
  const { context, owner } = createProfileAppearanceGateway(null);
  Object.assign(context, { runtimeConfig: harness.runtimeConfig });
  return { ...harness, context, owner };
}

describe("ShellGatewayOwner profile appearance integration", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
  });

  afterEach(() => {
    resetServerUiPrefsSync();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["context", "client", "profile", "config", "source", "offline", "reset"])(
    "discards lazy reconciliation after %s replacement",
    async (replacement) => {
      const { context, host, owner, snapshot, refreshTheme, request } =
        createProfileAppearanceGateway(null);
      patchSettings({ accent: "#112233" });
      const pending = owner.reconcileServerUiPrefs(context.runtimeConfig);
      if (replacement === "context") {
        Object.assign(host, { context: { ...context } });
      }
      if (replacement === "client") {
        snapshot.client = createProfileAppearanceGateway(null).snapshot.client;
      }
      if (replacement === "profile") {
        snapshot.selfUser = { id: "replacement" };
      }
      if (replacement === "config") {
        Object.assign(context.runtimeConfig.state, { configSnapshot: { config: {} } });
      }
      if (replacement === "source") {
        Object.assign(context, { runtimeConfig: { ...context.runtimeConfig } });
      }
      if (replacement === "offline") {
        snapshot.phase = "offline";
      }
      if (replacement === "reset") {
        owner.reset();
      }
      await pending;
      expect(loadSettings().accent).toBe("#112233");
      expect(refreshTheme).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(host.lastLocalePrefSignature).toBeNull();
    },
  );

  it("keeps bootstrap and deduplicated callers pending through actual profile hydration", async () => {
    const { context, owner, snapshot, request } = createProfileAppearanceGateway("profile-owner");
    const readStarted = createDeferred();
    const reply = createDeferred<{
      status: string;
      entries: { "ui.accent": string; "ui.sidebarEntries": string[] };
    }>();
    request.mockImplementationOnce(() => {
      readStarted.resolve();
      return reply.promise;
    });
    const ready = owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    expect(owner.ensureRuntimeConfig(snapshot, context.runtimeConfig)).toBe(ready);
    let complete = false;
    void ready.then(() => {
      complete = true;
    });
    await readStarted.promise;
    expect(complete).toBe(false);
    reply.resolve({ status: "ok", entries: { "ui.accent": "#336699", "ui.sidebarEntries": [] } });
    await ready;
    expect(complete).toBe(true);
    expect(loadSettings().accent).toBe("#336699");
  });

  it("refuses profile hydration from a superseded config snapshot", async () => {
    const { context, owner, snapshot, request, refreshTheme, requestUpdate } =
      createProfileAppearanceGateway("profile-owner");
    const readStarted = createDeferred();
    const reply = createDeferred<{
      status: string;
      entries: { "ui.accent": string; "ui.sidebarEntries": string[] };
    }>();
    request.mockImplementationOnce(() => {
      readStarted.resolve();
      return reply.promise;
    });
    const ready = owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    await readStarted.promise;
    // Initial identity adoption published its navigation reset before the held profile read.
    expect(refreshTheme).toHaveBeenCalledOnce();
    refreshTheme.mockClear();
    Object.assign(context.runtimeConfig.state, { configSnapshot: { config: {} } });
    reply.resolve({ status: "ok", entries: { "ui.accent": "#336699", "ui.sidebarEntries": [] } });
    await ready;
    expect(loadSettings().accent).not.toBe("#336699");
    expect(refreshTheme).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("loads current agent discovery when hello lands", async () => {
    const { context, host, owner, snapshot } = createProfileAppearanceGateway(null);
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender" as const,
      agents: [{ id: "main" }],
    };
    const ensureList = vi.fn(async () => agentsList);
    Object.assign(context, {
      agents: { state: { agentsList: null }, ensureList },
    });
    host.routeState.routeId = "chat";

    owner.synchronizeGateway(snapshot);
    await Promise.resolve();

    expect(ensureList).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "loads and caches profile appearance (matching browser mirror: %s)",
    async (mirrored) => {
      if (mirrored) {
        patchSettings({ gatewayUrl: "ws://profile.test", accent: "#336699" });
      }
      const {
        completeProfileAppearance,
        context,
        owner,
        refreshTheme,
        requestUpdate,
        request,
        snapshot,
      } = createProfileAppearanceGateway(mirrored ? "profile-owner" : null);
      owner.synchronizeGateway(snapshot);
      if (!mirrored) {
        owner.handleGatewayEvent({
          type: "event",
          event: "users.prefs.changed",
          payload: { profileId: "someone-else", keys: ["ui.accent"] },
        });
        expect(request).not.toHaveBeenCalled();
        snapshot.selfUser = { id: "profile-owner" };
        owner.synchronizeGateway(snapshot);
        void owner.reconcileServerUiPrefs(context.runtimeConfig);
        expect(refreshTheme).not.toHaveBeenCalled();
        expect(loadSettings().accent).toBeUndefined();
      }
      await completeProfileAppearance();
      await vi.dynamicImportSettled();
      // Adoption publishes navigation, then hydration publishes profile/readiness.
      expect(refreshTheme).toHaveBeenCalledTimes(2);
      expect(requestUpdate).toHaveBeenCalledOnce();
      expect(refreshTheme).toHaveBeenCalledWith({ notify: true });
      expect(loadSettings().accent).toBe("#336699");
      expect(request).toHaveBeenCalledExactlyOnceWith("users.prefs.get", {
        keys: [
          ...Object.values(UI_APPEARANCE_PREFERENCE_KEYS),
          ...Object.values(UI_NAVIGATION_PREFERENCE_KEYS),
        ],
      });
      request.mockClear();
      const configState = context.runtimeConfig.state as { configSnapshot: { config: unknown } };
      configState.configSnapshot = {
        config: { ui: { prefs: { accent: "#884422" } }, agents: { defaults: {} } },
      };
      await owner.reconcileServerUiPrefs(context.runtimeConfig);
      expect(request).not.toHaveBeenCalled();
      expect(loadSettings().accent).toBe("#336699");
    },
  );

  it.each(["profile-owner", "canonical-owner"])(
    "refreshes current profile appearance for its routed %s invalidation",
    async (eventProfileId) => {
      const { completeProfileAppearance, owner, refreshTheme, request, snapshot } =
        createProfileAppearanceGateway("profile-owner");
      owner.synchronizeGateway(snapshot);
      await completeProfileAppearance();
      expect(loadSettings().accent).toBe("#336699");
      request.mockClear();
      refreshTheme.mockClear();

      owner.handleGatewayEvent({
        type: "event",
        event: "users.prefs.changed",
        payload: {
          profileId: eventProfileId,
          keys: ["ui.accent"],
          entries: { "ui.accent": "#ffffff" },
        },
      });

      expect(loadSettings().accent).toBe("#336699");
      await completeProfileAppearance("#224466");
      expect(loadSettings().accent).toBe("#224466");
      expect(request).toHaveBeenCalledOnce();
      expect(refreshTheme).toHaveBeenCalledOnce();
    },
  );
});

describe("ShellGatewayOwner config invalidation", () => {
  it("permits saving after a blocked field discard's uncertain write is confirmed", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    let heldParams: unknown;
    let failFirst = true;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.set" && failFirst) {
        failFirst = false;
        heldParams = params;
        throw new Error("Transport acknowledgement unavailable");
      }
      return server.request(method, params);
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      await expect(runtimeConfig.flushFormChanges()).resolves.toBe(false);
      await expect(runtimeConfig.discardFormValue(["count"])).resolves.toBe(false);
      expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
      expect(runtimeConfig.state.lastError).toBeTruthy();
      await expect(
        runtimeConfig.patch({ raw: { unrelated: true }, note: "synthetic toggle" }),
      ).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
      await server.request("config.set", heldParams);
      await runtimeConfig.refresh();
      runtimeConfig.patchForm(["count"], 3);
      await expect(runtimeConfig.save()).resolves.toBe(true);
      expect(runtimeConfig.state.configForm).toEqual({ count: 3 });
      expect(server.submissions.map(({ raw }) => JSON.parse(raw))).toEqual([
        { count: 2 },
        { count: 3 },
      ]);
    } finally {
      runtimeConfig.setWritesSuspended(true);
      runtimeConfig.dispose();
    }
  });

  it("retries persisted but unapplied configuration on the confirmed revision after reconnect", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    let attempts = 0;
    let persistedHash: string | undefined;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.apply") {
        const submitted = params as { raw: string; baseHash: string };
        attempts++;
        if (attempts === 1) {
          const ack = (await server.request("config.set", params)) as { hash: string };
          persistedHash = ack.hash;
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "configuration persisted but was not applied",
          });
        }
        if (submitted.baseHash !== persistedHash) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "config changed since last load; re-run config.get and retry",
          });
        }
      }
      return server.request(method, params);
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      await expect(runtimeConfig.apply()).resolves.toBe(false);
      publish(false);
      publish(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimeConfig.state.lastError).toContain("was not applied");
      expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
      await expect(runtimeConfig.apply()).resolves.toBe(true);
      expect(attempts).toBe(2);
      expect(runtimeConfig.state.configNeedsApply).toBe(false);
      expect(runtimeConfig.state.lastError).toBeNull();
    } finally {
      runtimeConfig.setWritesSuspended(true);
      runtimeConfig.dispose();
    }
  });

  it.each(["confirmed", "unconfirmed"])(
    "handles a persisted Apply whose runtime revision is %s",
    async (outcome) => {
      vi.useFakeTimers();
      const server = createConfigServerMock();
      let applied = false;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.apply") {
          await server.request("config.set", params);
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "configuration persisted but was not applied",
          });
        }
        const response = await server.request(method, params);
        if (method === "config.get" && applied) {
          const snapshot = response as { configRevisionHash: string };
          return { ...snapshot, appliedConfigHash: snapshot.configRevisionHash };
        }
        return response;
      });
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        await expect(runtimeConfig.apply()).resolves.toBe(false);
        expect(runtimeConfig.state.lastError).toContain("was not applied");
        if (outcome === "confirmed") {
          applied = true;
          await runtimeConfig.refresh({ background: true });
          expect(runtimeConfig.state.configNeedsApply).toBe(false);
          expect(runtimeConfig.state.lastError).toBeNull();
        } else {
          runtimeConfig.patchForm(["count"], 2);
          await expect(runtimeConfig.discardFormValue(["count"])).resolves.toBe(false);
          expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
          expect(runtimeConfig.state.configNeedsApply).toBe(true);
          expect(runtimeConfig.state.lastError).toBeTruthy();
        }
        expect(server.submissions).toHaveLength(1);
      } finally {
        runtimeConfig.setWritesSuspended(true);
        runtimeConfig.dispose();
      }
    },
  );

  it.each(["failed", "superseded"] as const)(
    "retains a reverted autosave through a %s reconnect read and successor refresh",
    async (reconnectRead) => {
      vi.useFakeTimers();
      const { request: serverRequest, firstSet, submissions } = createDeferredSetServerMock();
      const heldRead = createDeferred<unknown>();
      let interceptRead = false;
      const request = vi.fn((method: string, params?: unknown) => {
        if (method === "config.get" && interceptRead) {
          interceptRead = false;
          return reconnectRead === "failed"
            ? Promise.reject(new Error("reconnect read unavailable"))
            : heldRead.promise;
        }
        return serverRequest(method, params);
      });
      const { runtimeConfig, publish } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        runtimeConfig.patchForm(["count"], 2);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        runtimeConfig.patchForm(["count"], 1);
        interceptRead = true;
        publish(false);
        publish(true);
        await vi.advanceTimersByTimeAsync(0);
        await runtimeConfig.refresh();
        heldRead.resolve({ config: { count: 1 }, raw: '{"count":1}', hash: "hash-1", valid: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
        expect(runtimeConfig.state.configFormDirty).toBe(true);
        expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
        expect(submissions).toHaveLength(1);
      } finally {
        runtimeConfig.setWritesSuspended(true);
        firstSet.resolve({});
        heldRead.resolve({});
        runtimeConfig.dispose();
      }
    },
  );

  it("retains an uncertain save after a definitive retry rejection", async () => {
    vi.useFakeTimers();
    const { request: serverRequest, firstSet } = createDeferredSetServerMock();
    let saves = 0;
    let failRecoveryRead = false;
    const patchRequest = vi.fn(async () => ({
      config: { count: 2, featureEnabled: true },
      hash: "patch-hash",
    }));
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.get" && failRecoveryRead) {
        return Promise.reject(new Error("Recovery read failed"));
      }
      if (method === "config.set" && ++saves === 2) {
        return Promise.reject(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "config changed since last load; re-run config.get and retry",
          }),
        );
      }
      return method === "config.patch" ? patchRequest() : serverRequest(method, params);
    });
    const { runtimeConfig, owner } = createShellConfig(request as GatewayBrowserClient["request"]);
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      runtimeConfig.patchForm(["count"], 1);
      firstSet.reject(new Error("Request timed out"));
      await vi.advanceTimersByTimeAsync(0);
      failRecoveryRead = true;
      await expect(runtimeConfig.save()).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimeConfig.state.lastError).toContain("Recovery read failed");
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
      await expect(
        runtimeConfig.patch({ raw: { featureEnabled: true }, note: "synthetic toggle" }),
      ).resolves.toBe(false);
      expect(patchRequest).not.toHaveBeenCalled();
      expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
      failRecoveryRead = false;
      owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
      expect(runtimeConfig.state.configFormDirty).toBe(true);
      expect(saves).toBe(2);
    } finally {
      runtimeConfig.setWritesSuspended(true);
      owner.dispose();
      runtimeConfig.dispose();
    }
  });

  it.each([false, true])(
    "reconciles a timed-out save before retrying a newer edit (explicit refresh: %s)",
    async (explicitRefresh) => {
      vi.useFakeTimers();
      const { request: serverRequest, submissions, firstSet } = createDeferredSetServerMock();
      let writes = 0;
      const request = vi.fn((method: string, params?: unknown) => {
        if (
          method === "config.set" &&
          ++writes > 1 &&
          (params as { baseHash: string }).baseHash !== "hash-2"
        ) {
          return Promise.reject(
            new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "config changed since last load; re-run config.get and retry",
            }),
          );
        }
        return serverRequest(method, params);
      });
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      const { context, owner } = createProfileAppearanceGateway(null);
      Object.assign(context, {
        runtimeConfig,
        agents: { state: { agentsList: null }, refreshList: vi.fn(async () => null) },
        agentSelection: { state: { selectedId: null } },
      });
      try {
        await runtimeConfig.ensureLoaded();
        runtimeConfig.patchForm(["count"], 2);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        firstSet.reject(new Error("Request timed out"));
        await vi.advanceTimersByTimeAsync(0);
        owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
        runtimeConfig.patchForm(["count"], 3);
        if (explicitRefresh) {
          await runtimeConfig.refresh();
        }
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        expect(writes).toBe(2);
        expect(runtimeConfig.state.configForm).toEqual({ count: 3 });
        if (!explicitRefresh) {
          expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
          await expect(runtimeConfig.retry()).resolves.toBe(true);
        }
        expect(submissions.map(({ raw }) => JSON.parse(raw))).toEqual([{ count: 2 }, { count: 3 }]);
        expect(runtimeConfig.state.configForm).toEqual({ count: 3 });
        expect(runtimeConfig.state.configFormDirty).toBe(false);
      } finally {
        runtimeConfig.setWritesSuspended(true);
        owner.dispose();
        runtimeConfig.dispose();
      }
    },
  );

  it.each([
    { revert: false, refresh: "event" },
    { revert: true, refresh: "event" },
    { revert: false, refresh: "reconnect" },
    { revert: true, refresh: "reconnect" },
  ] as const)(
    "keeps a correlated apply failure across $refresh (mid-apply revert: $revert)",
    async ({ revert, refresh }) => {
      vi.useFakeTimers();
      let storedRaw = '{\n  "count": 1\n}\n';
      let revision = 1;
      let appliedRevision = 1;
      let rejectApply: () => void = () => {
        throw new Error("apply request missing");
      };
      const protocol = new GatewayProtocolClient<Record<string, never>>({
        createRequestId: () => "synthetic-request",
        createSocket: (handlers) => ({
          isOpen: () => true,
          close: () => handlers.close(1000, ""),
          send: (data) => {
            const frame = JSON.parse(data) as {
              id: string;
              method: string;
              params: { raw?: string };
            };
            if (frame.method === "config.apply") {
              storedRaw = frame.params.raw ?? storedRaw;
              revision++;
              rejectApply = () =>
                handlers.message(
                  JSON.stringify({
                    type: "res",
                    id: frame.id,
                    ok: false,
                    error: {
                      code: "UNAVAILABLE",
                      message: "config.apply persisted but was not applied to the active Gateway",
                    },
                  }),
                );
            } else {
              handlers.message(
                JSON.stringify({
                  type: "res",
                  id: frame.id,
                  ok: true,
                  payload: {
                    config: JSON.parse(storedRaw),
                    raw: storedRaw,
                    hash: `hash-${revision}`,
                    configRevisionHash: `revision-${revision}`,
                    appliedConfigHash: `revision-${appliedRevision}`,
                    valid: true,
                    issues: [],
                  },
                }),
              );
            }
          },
        }),
        createRequestError: (error) =>
          new GatewayRequestError({
            code: error.code ?? "UNAVAILABLE",
            message: error.message ?? "request failed",
            details: error.details,
            retryable: error.retryable,
            retryAfterMs: error.retryAfterMs,
          }),
        buildConnectPlan: () => ({}),
        buildConnectParams: (plan) => plan,
        resolveClose: () => ({ retry: false, notify: false }),
        handshake: { mode: "require-challenge", timeoutMs: 100 },
        reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
      });
      protocol.start();
      const { runtimeConfig, publish, owner } = createShellConfig(protocol.request.bind(protocol));
      try {
        await runtimeConfig.ensureLoaded();
        expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
        if (revert) {
          runtimeConfig.patchForm(["count"], 2);
        }
        const applied = runtimeConfig.apply();
        if (revert) {
          runtimeConfig.patchForm(["count"], 1);
        }
        owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
        await vi.advanceTimersByTimeAsync(0);
        rejectApply();
        await expect(applied).resolves.toBe(false);
        expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
        expect(runtimeConfig.state.lastError).toContain("was not applied");
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
        if (refresh === "reconnect") {
          publish(false);
          publish(true);
        } else {
          owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
        expect(runtimeConfig.state.lastError).toContain("was not applied");
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
        expect(runtimeConfig.state.configNeedsApply).toBe(true);
        if (!revert) {
          appliedRevision = revision;
          await runtimeConfig.refresh();
          expect(runtimeConfig.state.configNeedsApply).toBe(false);
          expect(runtimeConfig.state.lastError).toBeNull();
        }
      } finally {
        runtimeConfig.setWritesSuspended(true);
        owner.dispose();
        runtimeConfig.dispose();
        protocol.stop();
      }
    },
  );

  it.each([false, true])(
    "keeps a timed-out revert when an independent patch follows a refreshed snapshot (foreign: %s)",
    async (foreign) => {
      vi.useFakeTimers();
      const { request: serverRequest, firstSet } = createDeferredSetServerMock();
      const patchRequest = vi.fn(async () => ({
        config: { count: foreign ? 3 : 2, featureEnabled: true },
        hash: "patch-hash",
      }));
      const request = vi.fn((method: string, params?: unknown) =>
        method === "config.patch" ? patchRequest() : serverRequest(method, params),
      );
      const { runtimeConfig, owner } = createShellConfig(
        request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        runtimeConfig.patchForm(["count"], 2);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        runtimeConfig.patchForm(["count"], 1);
        if (foreign) {
          serverRequest.mockResolvedValueOnce({
            config: { count: 3 },
            raw: '{\n  "count": 3\n}\n',
            hash: "foreign-hash",
            valid: true,
            issues: [],
          });
        }
        owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
        await vi.advanceTimersByTimeAsync(0);
        firstSet.reject(new Error("Request timed out"));
        await vi.advanceTimersByTimeAsync(0);

        await expect(
          runtimeConfig.patch({ raw: { featureEnabled: true }, note: "synthetic toggle" }),
        ).resolves.toBe(!foreign);
        expect(patchRequest).toHaveBeenCalledTimes(foreign ? 0 : 1);
        expect(runtimeConfig.state.configForm?.count).toBe(1);
        expect(runtimeConfig.state.configDraftBaseHash).toBe(foreign ? "hash-1" : "patch-hash");
        if (!foreign) {
          expect(runtimeConfig.state.configForm?.featureEnabled).toBe(true);
          expect(runtimeConfig.state.configFormDirty).toBe(true);
        }
      } finally {
        runtimeConfig.setWritesSuspended(true);
        firstSet.resolve({});
        owner.dispose();
        runtimeConfig.dispose();
      }
    },
  );

  it.each([
    { mode: "form", refresh: "event", foreign: false },
    { mode: "raw", refresh: "event", foreign: false },
    { mode: "form", refresh: "reconnect", foreign: false },
    { mode: "raw", refresh: "reconnect", foreign: false },
    { mode: "form", refresh: "reconnect", foreign: true },
    { mode: "raw", refresh: "reconnect", foreign: true },
  ] as const)(
    "retains a $mode no-op edit across $refresh (foreign snapshot: $foreign)",
    async ({ mode, refresh, foreign }) => {
      vi.useFakeTimers();
      const { request, submissions, firstSet } = createDeferredSetServerMock();
      const { runtimeConfig, publish, owner } = createShellConfig(
        request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        const originalRaw = runtimeConfig.state.configRawOriginal;
        runtimeConfig.patchForm(["count"], 2);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        runtimeConfig.patchForm(["count"], 1);
        firstSet.reject(new Error("Request timed out"));
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "raw") {
          runtimeConfig.setRaw(originalRaw);
        } else {
          runtimeConfig.patchForm(["count"], 1);
        }

        if (foreign) {
          request.mockResolvedValueOnce({
            config: { count: 3 },
            raw: '{\n  "count": 3\n}\n',
            hash: "foreign-hash",
            valid: true,
            issues: [],
          });
        }
        if (refresh === "reconnect") {
          publish(false);
          publish(true);
        } else {
          owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
        }
        await vi.advanceTimersByTimeAsync(0);

        expect(runtimeConfig.state.configSnapshot?.config).toEqual({ count: foreign ? 3 : 2 });
        expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
        expect(runtimeConfig.state.configRaw).toBe(originalRaw);
        expect(runtimeConfig.state.configDraftBaseHash).toBe(foreign ? "hash-1" : "hash-2");
        expect(runtimeConfig.state.configFormDirty).toBe(true);
        expect(submissions).toHaveLength(1);
        if (foreign) {
          expect(runtimeConfig.state.configRawOriginal).toBe(originalRaw);
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
          await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
          expect(submissions).toHaveLength(1);
          runtimeConfig.dispose();
          expect(submissions).toHaveLength(1);
        } else {
          expect(runtimeConfig.state.lastError).toBeNull();
          await expect(runtimeConfig.save()).resolves.toBe(true);
          expect(submissions[1]).toEqual({ raw: originalRaw, baseHash: "hash-2" });
        }
      } finally {
        if (foreign) {
          runtimeConfig.setWritesSuspended(true);
        }
        firstSet.resolve({});
        owner.dispose();
        runtimeConfig.dispose();
      }
    },
  );

  it("adopts a preserved foreign snapshot after a definitive save rejection", async () => {
    vi.useFakeTimers();
    const { request, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig, owner } = createShellConfig(request as GatewayBrowserClient["request"]);
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      runtimeConfig.patchForm(["count"], 1);
      request.mockResolvedValueOnce({
        config: { count: 3 },
        raw: '{\n  "count": 3\n}\n',
        hash: "foreign-hash",
        valid: true,
        issues: [],
      });
      owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
      firstSet.reject(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Write rejected" }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimeConfig.state.configForm).toEqual({ count: 3 });
      expect(runtimeConfig.state.configDraftBaseHash).toBe("foreign-hash");
      expect(runtimeConfig.state.configFormDirty).toBe(false);
    } finally {
      firstSet.resolve({});
      owner.dispose();
      runtimeConfig.dispose();
    }
  });

  it.each([false, true])(
    "reconciles a revert after a failed save (definitive rejection: %s)",
    async (rejected) => {
      vi.useFakeTimers();
      const { request, submissions, firstSet } = createDeferredSetServerMock();
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      const { context, owner } = createProfileAppearanceGateway(null);
      Object.assign(context, {
        runtimeConfig,
        agents: { state: { agentsList: null }, refreshList: vi.fn(async () => null) },
        agentSelection: { state: { selectedId: null } },
      });

      try {
        await runtimeConfig.ensureLoaded();
        runtimeConfig.patchForm(["count"], 2);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        runtimeConfig.patchForm(["count"], 3);
        runtimeConfig.patchForm(["count"], 1);
        firstSet.reject(
          rejected
            ? new GatewayRequestError({ code: "INVALID_REQUEST", message: "Write rejected" })
            : new Error("Request timed out"),
        );
        await vi.advanceTimersByTimeAsync(0);
        if (rejected) {
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
          expect(runtimeConfig.state.lastError).toBeNull();
          request.mockResolvedValueOnce({
            config: { count: 1 },
            raw: '{\n  "count": 1\n}\n',
            hash: "hash-1",
            valid: true,
            issues: [],
          });
        }

        owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);

        expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
        expect(runtimeConfig.state.configFormDirty).toBe(!rejected);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe(rejected ? "idle" : "error");
        if (!rejected) {
          expect(runtimeConfig.state.lastError).toContain("Request timed out");
        }
        expect(submissions).toHaveLength(1);
        runtimeConfig.dispose();
        await vi.advanceTimersByTimeAsync(0);
        expect(submissions).toHaveLength(1);
      } finally {
        firstSet.resolve({});
        owner.dispose();
        runtimeConfig.dispose();
      }
    },
  );

  it("shows a committed independent patch when its acknowledgement fails after config.changed", async () => {
    vi.useFakeTimers();
    const patchAck = createDeferred<unknown>();
    let count = 1;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: { count },
          raw: JSON.stringify({ count }),
          hash: `hash-${count}`,
          valid: true,
          issues: [],
        });
      }
      if (method === "config.patch") {
        count = 2;
        return patchAck.promise;
      }
      return Promise.resolve({});
    });
    const { runtimeConfig, owner } = createShellConfig(request as GatewayBrowserClient["request"]);

    try {
      await runtimeConfig.ensureLoaded();
      const patched = runtimeConfig.patch({ raw: { count: 2 }, note: "synthetic patch" });
      owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
      await vi.advanceTimersByTimeAsync(0);
      patchAck.reject(new Error("Acknowledgement lost"));

      await expect(patched).resolves.toBe(false);
      expect(runtimeConfig.state.configSnapshot?.config).toEqual({ count: 2 });
      expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
      expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
      expect(runtimeConfig.state.configFormDirty).toBe(false);
    } finally {
      patchAck.resolve({});
      owner.dispose();
      runtimeConfig.dispose();
    }
  });

  it.each(["form", "raw"] as const)(
    "retains a mid-save %s revert across config.changed",
    async (mode) => {
      vi.useFakeTimers();
      const { request, submissions, firstSet } = createDeferredSetServerMock();
      const { runtimeConfig, owner } = createShellConfig(
        request as GatewayBrowserClient["request"],
      );

      try {
        await runtimeConfig.ensureLoaded();
        const originalRaw = runtimeConfig.state.configRawOriginal;
        runtimeConfig.patchForm(["count"], 2);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        expect(submissions).toHaveLength(1);

        runtimeConfig.patchForm(["count"], 1);
        owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "raw") {
          runtimeConfig.setRaw(originalRaw);
          expect(runtimeConfig.state.configRaw).toBe(originalRaw);
          expect(runtimeConfig.state.configRawOriginal).toBe(originalRaw);
          expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-1");
        }
        const draftBeforeAck = runtimeConfig.state.configForm;

        firstSet.resolve({});
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "raw") {
          expect(submissions).toHaveLength(1);
          await expect(runtimeConfig.save()).resolves.toBe(true);
        }

        expect(draftBeforeAck).toEqual({ count: 1 });
        expect(submissions).toEqual([
          { raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
          { raw: '{\n  "count": 1\n}\n', baseHash: "hash-2" },
        ]);
        expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
        expect(runtimeConfig.state.configFormDirty).toBe(false);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
      } finally {
        firstSet.resolve({});
        owner.dispose();
        runtimeConfig.dispose();
      }
    },
  );
});
