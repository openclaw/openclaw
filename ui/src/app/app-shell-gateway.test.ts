/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { UI_APPEARANCE_PREFERENCE_KEYS } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { configServerTransport } from "../lib/config/config-suite.test-support.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
  createDeferredSetServerMock,
  createConfigServerMock,
  createGatewayHarness,
} from "../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createProfileAppearanceGateway } from "./app-shell-gateway.test-support.ts";
import { createGatewayMetadataObserver } from "./gateway-observers.ts";
import { UI_NAVIGATION_PREFERENCE_KEYS } from "./server-prefs-state.ts";
import { pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

function createShellConfig(
  request: Parameters<typeof createConfigCapabilityHarness>[0],
  discoverAgents = false,
) {
  const harness = createConfigCapabilityHarness(request);
  const { context, owner } = createProfileAppearanceGateway(null);
  Object.assign(context, { runtimeConfig: harness.runtimeConfig });
  if (discoverAgents) {
    Object.assign(context, {
      agents: { state: { agentsList: null }, refreshList: vi.fn(async () => null) },
      agentSelection: { state: { selectedId: null } },
    });
  }
  return { ...harness, context, owner };
}

function createDeferredConfig(suspend = true, discoverAgents = false) {
  const server = createDeferredSetServerMock();
  const harness = createShellConfig(server.request, discoverAgents);
  managedConfig(harness, () => server.firstSet.resolve({}), suspend);
  return { ...server, ...harness, config: harness.runtimeConfig };
}

type RuntimeConfig = ReturnType<typeof createConfigCapabilityHarness>["runtimeConfig"];
type ShellOwner = ReturnType<typeof createProfileAppearanceGateway>["owner"];

function managedConfig(
  harness: { runtimeConfig: RuntimeConfig; owner?: ShellOwner },
  release: () => void = () => undefined,
  suspend = true,
) {
  onTestFinished(() => {
    if (suspend) {
      harness.runtimeConfig.setWritesSuspended(true);
    }
    release();
    harness.owner?.dispose();
    harness.runtimeConfig.dispose();
  });
}

async function startAutosave(runtimeConfig: RuntimeConfig) {
  runtimeConfig.patchForm(["count"], 2);
  await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
}

async function beginRevertedSave(runtimeConfig: RuntimeConfig) {
  await runtimeConfig.ensureLoaded();
  await startAutosave(runtimeConfig);
  runtimeConfig.patchForm(["count"], 1);
}

function heldProfileRead(request: ReturnType<typeof createProfileAppearanceGateway>["request"]) {
  const started = createDeferred();
  const reply = createDeferred<ReturnType<typeof profileAppearance>>();
  request.mockImplementationOnce(() => {
    started.resolve();
    return reply.promise;
  });
  return { started, reply };
}

function configChanged(owner: ShellOwner) {
  owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
}

function expectState(config: RuntimeConfig, fields: Partial<RuntimeConfig["state"]>) {
  expect(config.state).toEqual(expect.objectContaining(fields));
}

function expectDraft(
  config: RuntimeConfig,
  count: number,
  fields: Partial<RuntimeConfig["state"]> = {},
) {
  expectState(config, { configForm: { count }, ...fields });
}

function invalidateConfig(
  harness: Pick<ReturnType<typeof createShellConfig>, "owner" | "publish">,
  refresh: "event" | "reconnect",
) {
  if (refresh === "reconnect") {
    harness.publish(false);
    harness.publish(true);
  } else {
    configChanged(harness.owner);
  }
  return vi.advanceTimersByTimeAsync(0);
}

function profileAppearance(accent: string, themeMode?: string) {
  return {
    status: "ok",
    entries: {
      "ui.accent": accent,
      "ui.railShortcuts": [],
      ...(themeMode ? { "ui.themeMode": themeMode } : {}),
    },
  };
}

function configSnapshot(count: number, hash = "foreign-hash") {
  return {
    config: { count },
    raw: `{
  "count": ${count}
}\n`,
    hash,
    valid: true,
    issues: [],
  };
}

function profileChanged(owner: ShellOwner, key = "ui.accent", profileId = "profile-owner") {
  owner.handleGatewayEvent({
    type: "event",
    event: "users.prefs.changed",
    payload: { profileId, keys: [key] },
  });
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

  it("replays offline preferences when hello precedes the config owner's connection publication", async () => {
    let config = { ui: { prefs: { accent: "#112233" } } };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.patch") {
        config = JSON.parse((params as { raw: string }).raw);
        return { config, hash: "patched" };
      }
      return { config, raw: JSON.stringify(config), hash: "initial", valid: true, issues: [] };
    });
    const { context, owner, snapshot } = createProfileAppearanceGateway(null);
    const client = { gatewayUrl: "ws://profile.test", request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    publish(false);
    // Shell listeners can observe hello before the config owner adopts its transport.
    const stopGateway = gateway.subscribe((next) => {
      Object.assign(snapshot, next);
      void owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    });
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    Object.assign(context, { runtimeConfig });
    const stopConfig = runtimeConfig.subscribe(() => {
      void owner.ensureRuntimeConfig(snapshot, runtimeConfig);
    });
    try {
      pushServerUiPrefs(runtimeConfig, { accent: "#336699" });
      publish(true);
      await vi.dynamicImportSettled();
      await owner.ensureRuntimeConfig(snapshot, runtimeConfig);
      expect(request.mock.calls.filter(([method]) => method === "config.patch")).toEqual([
        [
          "config.patch",
          {
            raw: JSON.stringify({ ui: { prefs: { accent: "#336699" } } }),
            note: "control-ui prefs sync",
          },
        ],
      ]);
      expect(config.ui.prefs.accent).toBe("#336699");
    } finally {
      stopConfig();
      stopGateway();
      runtimeConfig.dispose();
    }
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

  it.each(["bootstrap", "invalidation"])(
    "keeps %s and deduplicated callers pending through actual profile hydration",
    async (entry) => {
      const { context, owner, snapshot, request } = createProfileAppearanceGateway("profile-owner");
      const { started: readStarted, reply } = heldProfileRead(request);
      if (entry === "invalidation") {
        profileChanged(owner, "ui.accent");
        await readStarted.promise;
      }
      const ready =
        entry === "bootstrap"
          ? owner.ensureRuntimeConfig(snapshot, context.runtimeConfig)
          : owner.reconcileServerUiPrefs(context.runtimeConfig);
      if (entry === "bootstrap") {
        expect(owner.ensureRuntimeConfig(snapshot, context.runtimeConfig)).toBe(ready);
      }
      let complete = false;
      void ready.then(() => {
        complete = true;
      });
      await readStarted.promise;
      expect(complete).toBe(false);
      reply.resolve(profileAppearance("#336699"));
      await vi.dynamicImportSettled();
      expect(request).toHaveBeenCalledOnce();
      await ready;
      expect(complete).toBe(true);
      expect(loadSettings().accent).toBe("#336699");
      await owner.reconcileServerUiPrefs(context.runtimeConfig);
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("reconciles a profile read retired by a theme commit without reusing its pending source", async () => {
    const { context, owner, snapshot } = createProfileAppearanceGateway("profile-owner");
    const writeStarted = createDeferred();
    const writeReply = createDeferred<unknown>();
    const readStarted = createDeferred();
    const readReply = createDeferred<unknown>();
    const commitStarted = createDeferred();
    let reconciliation: Promise<void> | undefined;
    let reads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "themes.set") {
        writeStarted.resolve();
        return writeReply.promise;
      }
      expect(method).toBe("users.prefs.get");
      reads += 1;
      if (reads === 2) {
        readStarted.resolve();
        return readReply.promise;
      }
      return profileAppearance(reads === 1 ? "#336699" : "#22c55e", reads === 1 ? "dark" : "light");
    });
    Object.assign(snapshot.client!, { request });
    await owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    patchSettings({ themeMode: "light" });
    pushServerUiPrefs(
      context.runtimeConfig,
      { themeMode: "light" },
      {
        profileId: "profile-owner",
        canWrite: true,
        afterCommit: () => {
          reconciliation = owner.reconcileCommittedServerUiPrefs(context.runtimeConfig, false);
          commitStarted.resolve();
        },
      },
    );
    await writeStarted.promise;
    // themes.set publishes its committed invalidation before acknowledging the write.
    profileChanged(owner, "ui.themeMode");
    await readStarted.promise;
    writeReply.resolve({ application: "saved" });
    await commitStarted.promise;
    readReply.resolve(profileAppearance("#ff0000", "light"));
    await reconciliation;
    expect(loadSettings()).toMatchObject({ accent: "#22c55e", themeMode: "light" });
  });

  it("reads fresh profile appearance after reconnecting with the same client", async () => {
    const { context, owner, snapshot, request } = createProfileAppearanceGateway("profile-owner");
    request.mockResolvedValue(profileAppearance("#336699"));
    owner.synchronizeGateway(snapshot);
    await owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    expect(loadSettings().accent).toBe("#336699");

    const connected = { ...snapshot };
    snapshot.phase = "reconnecting";
    createGatewayMetadataObserver(() => true).synchronize(connected, snapshot);
    owner.synchronizeGateway(snapshot);
    request.mockResolvedValue(profileAppearance("#445566"));
    snapshot.phase = "connected";
    owner.synchronizeGateway(snapshot);
    await owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    expect(loadSettings().accent).toBe("#445566");
  });

  it("refuses profile hydration from a superseded config snapshot", async () => {
    const { context, owner, snapshot, request, refreshTheme, invalidate } =
      createProfileAppearanceGateway("profile-owner");
    const { started: readStarted, reply } = heldProfileRead(request);
    const ready = owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
    await readStarted.promise;
    // Initial identity adoption published its navigation reset before the held profile read.
    expect(refreshTheme).toHaveBeenCalledOnce();
    refreshTheme.mockClear();
    Object.assign(context.runtimeConfig.state, { configSnapshot: { config: {} } });
    reply.resolve(profileAppearance("#336699"));
    await ready;
    expect(loadSettings().accent).not.toBe("#336699");
    expect(refreshTheme).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
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
        invalidate,
        request,
        snapshot,
      } = createProfileAppearanceGateway(mirrored ? "profile-owner" : null);
      owner.synchronizeGateway(snapshot);
      if (!mirrored) {
        profileChanged(owner, "ui.accent", "someone-else");
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
      expect(invalidate).toHaveBeenCalledOnce();
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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  it("permits saving after a blocked field discard's uncertain write is confirmed", async () => {
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
    const { runtimeConfig: config } = createConfigCapabilityHarness(request);
    managedConfig({ runtimeConfig: config });
    await config.ensureLoaded();
    config.patchForm(["count"], 2);
    await config.flushFormChanges();
    await config.discardFormValue(["count"]);
      await server.request("config.set", heldParams);
    await config.refresh();
    config.patchForm(["count"], 3);
    await expect(config.save()).resolves.toBe(true);
    expectDraft(config, 3);
      expect(server.submissions.map(({ raw }) => JSON.parse(raw))).toEqual([
        { count: 2 },
        { count: 3 },
      ]);
  });

  it("retries persisted but unapplied configuration on the confirmed revision after reconnect", async () => {
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
    const { runtimeConfig: config, publish } = createConfigCapabilityHarness(request);
    managedConfig({ runtimeConfig: config });
    await config.ensureLoaded();
    config.patchForm(["count"], 2);
    await expect(config.apply()).resolves.toBe(false);
      publish(false);
      publish(true);
      await vi.advanceTimersByTimeAsync(0);
    expect(config.state.lastError).toContain("was not applied");
    expectDraft(config, 2);
    await expect(config.apply()).resolves.toBe(true);
      expect(attempts).toBe(2);
    expectState(config, { configNeedsApply: false, lastError: null });
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
      const { runtimeConfig: config, publish } = createConfigCapabilityHarness(request);
      managedConfig({ runtimeConfig: config }, () => {
        firstSet.resolve({});
        heldRead.resolve({});
      });
      await beginRevertedSave(config);
        interceptRead = true;
        publish(false);
        publish(true);
        await vi.advanceTimersByTimeAsync(0);
      await config.refresh();
        heldRead.resolve({ config: { count: 1 }, raw: '{"count":1}', hash: "hash-1", valid: true });
        await vi.advanceTimersByTimeAsync(0);
      expectDraft(config, 1, { configFormDirty: true, configDraftBaseHash: "hash-2" });
        expect(submissions).toHaveLength(1);
    },
  );

  it("retains an uncertain save after a definitive retry rejection", async () => {
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
    const { runtimeConfig: config, owner } = createShellConfig(request);
    managedConfig({ runtimeConfig: config, owner });
    await beginRevertedSave(config);
      firstSet.reject(new Error("Request timed out"));
      await vi.advanceTimersByTimeAsync(0);
      failRecoveryRead = true;
    await expect(config.save()).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(0);
    expect(config.state.lastError).toContain("Recovery read failed");
    expect(config.state.configAutoSaveStatus).toBe("error");
      await expect(
      config.patch({ raw: { featureEnabled: true }, note: "synthetic toggle" }),
      ).resolves.toBe(false);
      expect(patchRequest).not.toHaveBeenCalled();
    expectDraft(config, 1);
      failRecoveryRead = false;
      configChanged(owner);
      await vi.advanceTimersByTimeAsync(0);
    expectDraft(config, 1, { configFormDirty: true });
      expect(saves).toBe(2);
  });

  it.each([false, true])(
    "reconciles a timed-out save before retrying a newer edit (explicit refresh: %s)",
    async (explicitRefresh) => {
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
      const { runtimeConfig: config, owner } = createShellConfig(request, true);
      managedConfig({ runtimeConfig: config, owner });
      await config.ensureLoaded();
      await startAutosave(config);
        firstSet.reject(new Error("Request timed out"));
        await vi.advanceTimersByTimeAsync(0);
        configChanged(owner);
      config.patchForm(["count"], 3);
        if (explicitRefresh) {
        await config.refresh();
        }
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        expect(writes).toBe(2);
      expectDraft(config, 3);
        if (!explicitRefresh) {
        expectState(config, { configDraftBaseHash: "hash-2", configAutoSaveStatus: "error" });
        await expect(config.retry()).resolves.toBe(true);
        }
        expect(submissions.map(({ raw }) => JSON.parse(raw))).toEqual([{ count: 2 }, { count: 3 }]);
      expectDraft(config, 3, { configFormDirty: false });
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
      let storedRaw = '{\n  "count": 1\n}\n';
      let revision = 1;
      let appliedRevision = 1;
      let rejectApply: () => void = () => {
        throw new Error("apply request missing");
      };
      const protocol = configServerTransport(
        async (frame) => {
            if (frame.method === "config.apply") {
            storedRaw = (frame.params as { raw?: string }).raw ?? storedRaw;
              revision++;
            const response = createDeferred<{
              ok: false;
              error: { code: string; message: string };
            }>();
              rejectApply = () =>
              response.resolve({
                    ok: false,
                    error: {
                      code: "UNAVAILABLE",
                      message: "config.apply persisted but was not applied to the active Gateway",
                    },
              });
            return response.promise;
          }
          return {
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
          };
          },
        () => "synthetic-request",
      );
      protocol.start();
      const {
        runtimeConfig: config,
        publish,
        owner,
      } = createShellConfig(protocol.request.bind(protocol));
      try {
        await config.ensureLoaded();
        expectDraft(config, 1);
        if (revert) {
          config.patchForm(["count"], 2);
        }
        const applied = config.apply();
        if (revert) {
          config.patchForm(["count"], 1);
        }
        configChanged(owner);
        await vi.advanceTimersByTimeAsync(0);
        rejectApply();
        await expect(applied).resolves.toBe(false);
        expectDraft(config, 1);
        expect(config.state.lastError).toContain("was not applied");
        expect(config.state.configAutoSaveStatus).toBe("error");
        await invalidateConfig({ owner, publish }, refresh);
        expectDraft(config, 1);
        expect(config.state.lastError).toContain("was not applied");
        expectState(config, { configAutoSaveStatus: "error", configNeedsApply: true });
        if (!revert) {
          appliedRevision = revision;
          await config.refresh();
          expectState(config, { configNeedsApply: false, lastError: null });
        }
      } finally {
        config.setWritesSuspended(true);
        owner.dispose();
        config.dispose();
        protocol.stop();
      }
    },
  );

  it.each([false, true])(
    "keeps a timed-out revert when an independent patch follows a refreshed snapshot (foreign: %s)",
    async (foreign) => {
      const { request: serverRequest, firstSet } = createDeferredSetServerMock();
      const patchRequest = vi.fn(async () => ({
        config: { count: foreign ? 3 : 2, featureEnabled: true },
        hash: "patch-hash",
      }));
      const request = vi.fn((method: string, params?: unknown) =>
        method === "config.patch" ? patchRequest() : serverRequest(method, params),
      );
      const { runtimeConfig: config, owner } = createShellConfig(request);
      managedConfig({ runtimeConfig: config, owner }, () => firstSet.resolve({}));
      await beginRevertedSave(config);
        if (foreign) {
          serverRequest.mockResolvedValueOnce(configSnapshot(3));
        }
        configChanged(owner);
        await vi.advanceTimersByTimeAsync(0);
        firstSet.reject(new Error("Request timed out"));
        await vi.advanceTimersByTimeAsync(0);

        await expect(
        config.patch({ raw: { featureEnabled: true }, note: "synthetic toggle" }),
        ).resolves.toBe(!foreign);
        expect(patchRequest).toHaveBeenCalledTimes(foreign ? 0 : 1);
      expect(config.state.configForm?.count).toBe(1);
      expect(config.state.configDraftBaseHash).toBe(foreign ? "hash-1" : "patch-hash");
        if (!foreign) {
        expect(config.state.configForm?.featureEnabled).toBe(true);
        expect(config.state.configFormDirty).toBe(true);
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
      const harness = createDeferredConfig(foreign);
      const { request, submissions, firstSet, config } = harness;
      await config.ensureLoaded();
      const originalRaw = config.state.configRawOriginal;
      await startAutosave(config);
      config.patchForm(["count"], 1);
        firstSet.reject(new Error("Request timed out"));
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "raw") {
        config.setRaw(originalRaw);
        } else {
        config.patchForm(["count"], 1);
        }

        if (foreign) {
          request.mockResolvedValueOnce(configSnapshot(3));
        }
      await invalidateConfig(harness, refresh);

      expect(config.state.configSnapshot?.config).toEqual({ count: foreign ? 3 : 2 });
      expectDraft(config, 1, {
        configRaw: originalRaw,
        configDraftBaseHash: foreign ? "hash-1" : "hash-2",
        configFormDirty: true,
      });
        expect(submissions).toHaveLength(1);
        if (foreign) {
        expectState(config, { configRawOriginal: originalRaw, configAutoSaveStatus: "conflict" });
          await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
          expect(submissions).toHaveLength(1);
        config.dispose();
          expect(submissions).toHaveLength(1);
        } else {
        expect(config.state.lastError).toBeNull();
        await expect(config.save()).resolves.toBe(true);
          expect(submissions[1]).toEqual({ raw: originalRaw, baseHash: "hash-2" });
        }
    },
  );

  it("adopts a preserved foreign snapshot after a definitive save rejection", async () => {
    const { request, firstSet, config, owner } = createDeferredConfig(false);
    await beginRevertedSave(config);
      request.mockResolvedValueOnce(configSnapshot(3));
      configChanged(owner);
      await vi.advanceTimersByTimeAsync(0);
    expectDraft(config, 1);
      firstSet.reject(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Write rejected" }),
      );
      await vi.advanceTimersByTimeAsync(0);
    expectDraft(config, 3, { configDraftBaseHash: "foreign-hash", configFormDirty: false });
  });

  it.each([false, true])(
    "reconciles a revert after a failed save (definitive rejection: %s)",
    async (rejected) => {
      const { request, submissions, firstSet, config, owner } = createDeferredConfig(false, true);
      await config.ensureLoaded();
      await startAutosave(config);
      config.patchForm(["count"], 3);
      config.patchForm(["count"], 1);
        firstSet.reject(
          rejected
            ? new GatewayRequestError({ code: "INVALID_REQUEST", message: "Write rejected" })
            : new Error("Request timed out"),
        );
        await vi.advanceTimersByTimeAsync(0);
        if (rejected) {
        expectState(config, { configAutoSaveStatus: "idle", lastError: null });
          request.mockResolvedValueOnce(configSnapshot(1, "hash-1"));
        }

        configChanged(owner);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);

      expectDraft(config, 1, {
        configFormDirty: !rejected,
        configAutoSaveStatus: rejected ? "idle" : "error",
      });
        if (!rejected) {
        expect(config.state.lastError).toContain("Request timed out");
        }
        expect(submissions).toHaveLength(1);
      config.dispose();
        await vi.advanceTimersByTimeAsync(0);
        expect(submissions).toHaveLength(1);
    },
  );

  it("shows a committed independent patch when its acknowledgement fails after config.changed", async () => {
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
    const { runtimeConfig: config, owner } = createShellConfig(request);

    managedConfig({ runtimeConfig: config, owner }, () => patchAck.resolve({}), false);
    await config.ensureLoaded();
    const patched = config.patch({ raw: { count: 2 }, note: "synthetic patch" });
      configChanged(owner);
      await vi.advanceTimersByTimeAsync(0);
      patchAck.reject(new Error("Acknowledgement lost"));

      await expect(patched).resolves.toBe(false);
    expect(config.state.configSnapshot?.config).toEqual({ count: 2 });
    expectDraft(config, 2, { configDraftBaseHash: "hash-2", configFormDirty: false });
  });

  it.each(["form", "raw"] as const)(
    "retains a mid-save %s revert across config.changed",
    async (mode) => {
      const { submissions, firstSet, config, owner } = createDeferredConfig(false);
      await config.ensureLoaded();
      const originalRaw = config.state.configRawOriginal;
      await startAutosave(config);
        expect(submissions).toHaveLength(1);

      config.patchForm(["count"], 1);
        configChanged(owner);
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "raw") {
        config.setRaw(originalRaw);
        expectState(config, {
          configRaw: originalRaw,
          configRawOriginal: originalRaw,
          configDraftBaseHash: "hash-1",
        });
        }
      const draftBeforeAck = config.state.configForm;

        firstSet.resolve({});
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "raw") {
          expect(submissions).toHaveLength(1);
        await expect(config.save()).resolves.toBe(true);
        }

        expect(draftBeforeAck).toEqual({ count: 1 });
        expect(submissions).toEqual([
          { raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
          { raw: '{\n  "count": 1\n}\n', baseHash: "hash-2" },
        ]);
      expectDraft(config, 1, { configFormDirty: false, configAutoSaveStatus: "saved" });
    },
  );
});
