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
import { createChatPageSessions } from "../pages/chat/chat-page.test-support.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { ShellGatewayOwner, type ShellGatewayHost } from "./app-shell-gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

function createProfileAppearanceGateway(profileId: string | null) {
  const pendingResponses: Array<(accent: string) => void> = [];
  const request = vi.fn(
    () =>
      new Promise<{ status: string; entries: { "ui.accent": string } }>((resolve) => {
        pendingResponses.push((accent) =>
          resolve({ status: "ok", entries: { "ui.accent": accent } }),
        );
      }),
  );
  const client = {
    gatewayUrl: "ws://profile.test",
    request,
  } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected",
    sessionKey: "",
    selfUser: profileId ? { id: profileId } : null,
    hello: { auth: { role: "operator", scopes: ["operator.write"] } },
  } as ApplicationGatewaySnapshot;
  const refreshTheme = vi.fn();
  const connectionBootstrap = {
    reset: vi.fn(),
    run: (_key: string, task: () => Promise<unknown>) => task(),
    synchronize: vi.fn(),
  };
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://profile.test" },
      snapshot,
    },
    connectionBootstrap,
    sessions: createChatPageSessions(),
    runtimeConfig: {
      canPatch: false,
      ensureLoaded: vi.fn(async () => undefined),
      runExternalMutation: vi.fn(),
      state: {
        client,
        connected: true,
        configSnapshot: { config: { ui: { prefs: { accent: "#ff0000" } } } },
      },
    },
    theme: { refresh: refreshTheme, recordServerSelection: vi.fn() },
  } as unknown as ApplicationContext;
  const host = {
    context,
    activeSessionKey: "",
    agentRosterRefreshTimer: null,
    agentsListClient: null,
    agentsListSource: null,
    lastLocalePrefSignature: null,
    outboxStoreImport: { load: vi.fn(async () => undefined) },
    previousGatewayPhase: null,
    recoverDeletedActiveSession: vi.fn(),
    routeState: {},
    runtimeConfigClient: null,
    runtimeConfigSource: null,
    sessionKeyClient: null,
  } as unknown as ShellGatewayHost;
  return {
    async completeProfileAppearance(this: void, accent = "#336699") {
      await vi.waitFor(() => {
        expect(pendingResponses).toHaveLength(1);
      });
      const respond = pendingResponses.shift();
      expect(respond, "pending users.prefs.get response").toBeDefined();
      // Config reconciliation can also refresh the theme. Arm this only when
      // releasing this request, after any synchronous reconciliation has finished.
      const refreshed = new Promise<void>((resolve) => {
        refreshTheme.mockImplementationOnce(resolve);
      });
      respond!(accent);
      return refreshed;
    },
    context,
    host,
    owner: new ShellGatewayOwner(host),
    refreshTheme,
    request,
    snapshot,
  };
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

  it("never requests durable profile preferences for an identity-free connection", () => {
    const { owner, request, snapshot } = createProfileAppearanceGateway(null);

    owner.synchronizeGateway(snapshot);
    owner.handleGatewayEvent({
      type: "event",
      event: "users.prefs.changed",
      payload: { profileId: "someone-else", keys: ["ui.accent"] },
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("refreshes the cached agent roster when hello lands", async () => {
    const { context, host, owner, snapshot } = createProfileAppearanceGateway(null);
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender" as const,
      agents: [{ id: "main" }],
    };
    const ensureList = vi.fn(async () => agentsList);
    Object.assign(context, {
      agents: { state: { agentsList, agentsListCached: true }, ensureList },
    });
    host.routeState.routeId = "chat";

    owner.synchronizeGateway(snapshot);
    await Promise.resolve();

    expect(ensureList).toHaveBeenCalledOnce();
  });

  it("loads profile appearance when authenticated presence appears on an existing connection", async () => {
    const { completeProfileAppearance, context, owner, refreshTheme, request, snapshot } =
      createProfileAppearanceGateway(null);
    owner.synchronizeGateway(snapshot);
    snapshot.selfUser = { id: "profile-owner" };

    owner.synchronizeGateway(snapshot);

    owner.reconcileServerUiPrefs(context.runtimeConfig);
    expect(refreshTheme).not.toHaveBeenCalled();
    expect(loadSettings().accent).toBeUndefined();
    await completeProfileAppearance();
    expect(refreshTheme).toHaveBeenCalledOnce();
    expect(loadSettings().accent).toBe("#336699");
    expect(request).toHaveBeenCalledOnce();
    // Derived from the wire contract so new appearance keys extend the
    // request without silently invalidating this expectation.
    expect(request).toHaveBeenCalledWith("users.prefs.get", {
      keys: Object.values(UI_APPEARANCE_PREFERENCE_KEYS),
    });
  });

  it("republishes profile provenance even when its appearance matches the browser mirror", async () => {
    patchSettings({ accent: "#336699" });
    const { completeProfileAppearance, owner, refreshTheme, snapshot } =
      createProfileAppearanceGateway("profile-owner");

    owner.synchronizeGateway(snapshot);

    await completeProfileAppearance();
    expect(refreshTheme).toHaveBeenCalledOnce();
    expect(loadSettings().accent).toBe("#336699");
  });

  it("reuses cached profile preferences across unrelated gateway config snapshots", async () => {
    const { completeProfileAppearance, context, owner, request, snapshot } =
      createProfileAppearanceGateway("profile-owner");
    owner.synchronizeGateway(snapshot);
    await completeProfileAppearance();
    expect(loadSettings().accent).toBe("#336699");
    request.mockClear();
    const configState = context.runtimeConfig.state as {
      configSnapshot: { config: unknown };
    };
    configState.configSnapshot = {
      config: { ui: { prefs: { accent: "#884422" } }, agents: { defaults: {} } },
    };

    owner.reconcileServerUiPrefs(context.runtimeConfig);

    expect(request).not.toHaveBeenCalled();
    expect(loadSettings().accent).toBe("#336699");
  });

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

  it("clears an uncertain Apply error when background revision polling confirms application", async () => {
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
      applied = true;
      await runtimeConfig.refresh({ background: true });
      expect(runtimeConfig.state.configNeedsApply).toBe(false);
      expect(runtimeConfig.state.lastError).toBeNull();
      expect(server.submissions).toHaveLength(1);
    } finally {
      runtimeConfig.setWritesSuspended(true);
      runtimeConfig.dispose();
    }
  });

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

  it("does not discard a field while persisted Apply remains unconfirmed", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.apply") {
        await server.request("config.set", params);
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "configuration persisted but was not applied",
        });
      }
      return server.request(method, params);
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    try {
      await runtimeConfig.ensureLoaded();
      await expect(runtimeConfig.apply()).resolves.toBe(false);
      runtimeConfig.patchForm(["count"], 2);
      await expect(runtimeConfig.discardFormValue(["count"])).resolves.toBe(false);
      expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
      expect(runtimeConfig.state.configNeedsApply).toBe(true);
      expect(runtimeConfig.state.lastError).toBeTruthy();
      expect(server.submissions).toHaveLength(1);
    } finally {
      runtimeConfig.setWritesSuspended(true);
      runtimeConfig.dispose();
    }
  });

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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    const { context, owner } = createProfileAppearanceGateway(null);
    Object.assign(context, { runtimeConfig });
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
      const { runtimeConfig, publish } = createConfigCapabilityHarness(
        protocol.request.bind(protocol),
      );
      const { context, owner } = createProfileAppearanceGateway(null);
      Object.assign(context, { runtimeConfig });
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
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      const { context, owner } = createProfileAppearanceGateway(null);
      Object.assign(context, { runtimeConfig });
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

  it.each(["form", "raw"] as const)(
    "retains a clean-looking %s revert when reconnect finds foreign content",
    async (mode) => {
      vi.useFakeTimers();
      const { request, submissions, firstSet } = createDeferredSetServerMock();
      const { runtimeConfig, publish } = createConfigCapabilityHarness(
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
        request.mockResolvedValueOnce({
          config: { count: 3 },
          raw: '{\n  "count": 3\n}\n',
          hash: "foreign-hash",
          valid: true,
          issues: [],
        });
        publish(false);
        publish(true);
        await vi.advanceTimersByTimeAsync(0);

        expect(runtimeConfig.state.configSnapshot?.config).toEqual({ count: 3 });
        expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
        expect(runtimeConfig.state.configRaw).toBe(originalRaw);
        expect(runtimeConfig.state.configRawOriginal).toBe(originalRaw);
        expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-1");
        expect(runtimeConfig.state.configFormDirty).toBe(true);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
        expect(submissions).toHaveLength(1);
        runtimeConfig.dispose();
        expect(submissions).toHaveLength(1);
      } finally {
        runtimeConfig.setWritesSuspended(true);
        firstSet.resolve({});
        runtimeConfig.dispose();
      }
    },
  );

  it.each([
    { mode: "form", refresh: "event" },
    { mode: "raw", refresh: "event" },
    { mode: "form", refresh: "reconnect" },
    { mode: "raw", refresh: "reconnect" },
  ] as const)(
    "retains a $mode no-op edit after an uncertain save until $refresh reconciles its commit",
    async ({ mode, refresh }) => {
      vi.useFakeTimers();
      const { request, submissions, firstSet } = createDeferredSetServerMock();
      const { runtimeConfig, publish } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      const { context, owner } = createProfileAppearanceGateway(null);
      Object.assign(context, { runtimeConfig });
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

        if (refresh === "reconnect") {
          publish(false);
          publish(true);
        } else {
          owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
        }
        await vi.advanceTimersByTimeAsync(0);

        expect(runtimeConfig.state.configSnapshot?.config).toEqual({ count: 2 });
        expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
        expect(runtimeConfig.state.configRaw).toBe(originalRaw);
        expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
        expect(runtimeConfig.state.configFormDirty).toBe(true);
        expect(runtimeConfig.state.lastError).toBeNull();
        expect(submissions).toHaveLength(1);
        await expect(runtimeConfig.save()).resolves.toBe(true);
        expect(submissions[1]).toEqual({ raw: originalRaw, baseHash: "hash-2" });
      } finally {
        firstSet.resolve({});
        owner.dispose();
        runtimeConfig.dispose();
      }
    },
  );

  it("adopts a preserved foreign snapshot after a definitive save rejection", async () => {
    vi.useFakeTimers();
    const { request, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    const { context, owner } = createProfileAppearanceGateway(null);
    Object.assign(context, { runtimeConfig });
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    const { context, owner } = createProfileAppearanceGateway(null);
    Object.assign(context, { runtimeConfig });

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
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      const { context, owner } = createProfileAppearanceGateway(null);
      Object.assign(context, { runtimeConfig });

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
