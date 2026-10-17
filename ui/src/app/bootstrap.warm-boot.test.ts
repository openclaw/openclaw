import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import { loadChatRoute } from "../pages/chat/route-loader.ts";
import * as snapshots from "../pages/chat/session-snapshot-invalidation.runtime.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { clearBootRecords, type BootRecord } from "./boot-record.ts";
import { bootstrapApplication as createApplication } from "./bootstrap.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import * as gatewayStore from "./gateway-store.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

let activeRuntime: ReturnType<typeof createApplication> | undefined;
let previousUrl: string;
function bootstrapApplication() {
  return (activeRuntime = createApplication());
}
function captureGatewayListeners(revision?: () => number) {
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const createGateway = gatewayStore.createApplicationGateway;
  vi.spyOn(gatewayStore, "createApplicationGateway").mockImplementation((...args) => {
    const gateway = createGateway(...args);
    if (revision) {
      vi.spyOn(gateway, "connectionRevision", "get").mockImplementation(revision);
    }
    vi.spyOn(gateway, "subscribe").mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    return gateway;
  });
  return listeners;
}

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";

function seedBootRecord(overrides: Partial<BootRecord> = {}): BootRecord {
  const record: BootRecord = {
    version: 2,
    authMethod: "token",
    credential: "9d17676d",
    scope: gatewayCredentialScope(loadSettings().gatewayUrl),
    savedAt: Date.now(),
    profileId: "profile-a",
    agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
    groups: [],
    sectionOrder: [],
    ...overrides,
  };
  localStorage.setItem(BOOT_RECORD_PREFIX + record.scope, JSON.stringify(record));
  return record;
}

describe("warm boot profile validation", () => {
  beforeEach(() => {
    previousUrl = window.location.href;
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    persistSessionToken(loadSettings().gatewayUrl, "test-token");
  });
  afterEach(() => {
    activeRuntime?.stop();
    activeRuntime = undefined;
    window.history.replaceState({}, "", previousUrl);
    clearBootRecords();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("admits a previously signed-in trusted-proxy account before server connection", async () => {
    window.history.replaceState({}, "", "/chat/main");
    persistSessionToken(loadSettings().gatewayUrl, "");
    seedBootRecord({
      authMethod: "trusted-proxy",
      credential: "",
      recoveryScope: "account-a",
      agents: {
        defaultId: "main",
        mainKey: "workspace",
        scope: "per-sender",
        agents: [{ id: "main" }],
      },
    });
    const runtime = bootstrapApplication();
    expect(runtime.warmBoot).toBe(true);
    expect(runtime.context.gateway.snapshot.phase).toBe("stopped");
    expect(runtime.context.gateway.snapshot.hello).toBeNull();
    const client = new GatewayBrowserClient({
      url: loadSettings().gatewayUrl,
      offlineRecoveryScope: "account-a",
    });
    const request = vi.spyOn(client, "request");
    runtime.context.gateway.snapshot.client = client;
    expect(runtime.context.agents.state.agentsList).toBeNull();
    expect(runtime.context.offlineSessionDefaults).toEqual({
      mainKey: "workspace",
      scope: "per-sender",
    });
    await expect(
      loadChatRoute(
        runtime.context,
        { pathname: "/chat/main", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "session", sessionKey: "agent:main:workspace" });
    expect(request).not.toHaveBeenCalled();
    expect(runtime.context.agents.state.agentsList).toBeNull();
    runtime.context.gateway.snapshot.phase = "connected";
    expect(runtime.context.offlineSessionDefaults).toBeNull();
    runtime.context.gateway.snapshot.phase = "reconnecting";
    runtime.context.gateway.snapshot.client = new GatewayBrowserClient({
      url: loadSettings().gatewayUrl,
      offlineRecoveryScope: "another-account",
    });
    expect(runtime.context.offlineSessionDefaults).toBeNull();
    runtime.context.gateway.snapshot.client = client;
    client.retireOfflineRecoveryScope();
    expect(runtime.context.offlineSessionDefaults).toBeNull();
  });

  it("does not revive warm admission after pairing rejection followed by network loss", () => {
    window.history.replaceState({}, "", "/chat");
    const { scope } = seedBootRecord({ profileId: null });
    sessionStorage.setItem("retained-draft", "Keep this draft");
    const fixture = createGatewayStoreTestStore();
    vi.spyOn(gatewayStore, "createApplicationGateway").mockReturnValue(fixture.gateway);
    const runtime = bootstrapApplication();
    expect(runtime.warmBoot).toBe(true);
    fixture.gateway.connect();
    fixture.current().opts.onClose?.({
      code: 4008,
      reason: "pairing required",
      willRetry: true,
      error: { code: "PAIRING_REQUIRED", message: "Pairing required" },
    });
    expect(runtime.warmBoot).toBe(false);
    fixture
      .current()
      .opts.onClose?.({ code: 1006, reason: "network unavailable", willRetry: true });
    expect(fixture.gateway.snapshot.lastErrorCode).toBeNull();
    expect(runtime.warmBoot).toBe(false);
    expect(localStorage.getItem(BOOT_RECORD_PREFIX + scope)).toBeNull();
    expect(sessionStorage.getItem("retained-draft")).toBe("Keep this draft");
  });

  it("keeps a version2 roster private until live discovery, including same-profile reconnect failure", async () => {
    const record = seedBootRecord({
      recoveryScope: "test-recovery-scope",
      agents: {
        defaultId: "private",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "private", name: "Private agent" }, { id: "shared" }],
      },
      groups: [{ name: "Personal", position: 0 }],
      sectionOrder: ["Personal"],
    });
    const listeners = captureGatewayListeners();
    const discovery = createDeferred<AgentsListResult>();
    let discoveryFailed = false;
    const request = vi.fn(async (method: string) => {
      if (method !== "agents.list") {
        return {};
      }
      if (discoveryFailed) {
        throw new Error("roster unavailable");
      }
      return discovery.promise;
    });
    const client = createTestGatewayClient(request);
    const runtime = bootstrapApplication();
    const publish = (phase: ApplicationGatewaySnapshot["phase"]) => {
      const snapshot = runtime.context.gateway.snapshot;
      Object.assign(snapshot, {
        phase,
        client,
        selfUser: { id: "profile-a" },
        hello: {
          type: "hello-ok",
          protocol: 4,
          auth: { method: "token", recoveryScope: "test-recovery-scope" },
        },
      });
      listeners.forEach((listener) => listener(snapshot));
    };
    const agents = runtime.context.agents;
    expect(agents.state.agentsList).toBeNull();
    expect(runtime.context.sessions.state.groupSettings).toEqual(record.groups);
    expect(runtime.context.sessions.state.sectionOrder).toEqual(record.sectionOrder);
    publish("connected");
    const pending = agents.ensureList();
    expect(agents.state.agentsList).toBeNull();
    discovery.resolve({
      ...record.agents,
      mainKey: "workspace",
      scope: "global",
      agents: [{ id: "shared" }],
    });
    await pending;
    expect(agents.state.agentsList?.agents).toEqual([{ id: "shared" }]);

    publish("reconnecting");
    expect(agents.state.agentsList).toBeNull();
    expect(runtime.context.offlineSessionDefaults).toEqual({
      mainKey: "workspace",
      scope: "global",
    });
    discoveryFailed = true;
    publish("connected");
    await agents.ensureList();
    expect(agents.state.agentsList).toBeNull();
    expect(agents.state.agentsError).toContain("roster unavailable");
    expect(request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(2);
  });

  it.each([
    { profileId: "profile-b", clears: 1, credentialsChanged: false },
    { profileId: "profile-a", clears: 0, credentialsChanged: false },
    { profileId: "profile-b", clears: 0, credentialsChanged: true },
  ])(
    "clears $clears times for connected $profileId (credential change: $credentialsChanged)",
    async ({ profileId, clears, credentialsChanged }) => {
      const cachedProfileId = "profile-a";
      window.history.replaceState({}, "", "/chat");
      const { scope } = seedBootRecord({
        profileId: cachedProfileId,
        recoveryScope: "cached-account",
      });
      const clearSnapshots = vi.spyOn(snapshots, "clearStoredChatSnapshots").mockResolvedValue();
      let connectionRevision = 0;
      const listeners = captureGatewayListeners(() => connectionRevision);
      const runtime = bootstrapApplication();
      const publish = (phase: ApplicationGatewaySnapshot["phase"]) => {
        const snapshot = runtime.context.gateway.snapshot;
        Object.assign(snapshot, {
          phase,
          hello: {
            type: "hello-ok",
            protocol: 1,
            auth: {
              method: "token",
              role: "operator",
              scopes: [],
              recoveryScope:
                profileId === cachedProfileId ? "cached-account" : "replacement-account",
            },
          },
          selfUser: { id: profileId },
        });
        listeners.forEach((listener) => listener(snapshot));
      };
      expect(runtime.warmBoot).toBe(true);
      if (credentialsChanged) {
        connectionRevision += 1;
      }
      publish("connecting");
      expect(clearSnapshots).not.toHaveBeenCalled();

      publish("connected");
      // Clearing the in-memory projection must precede later hello subscribers.
      expect(clearSnapshots).toHaveBeenCalledTimes(clears);
      // The persisted record gates the next boot, so it must be gone before any lazy cleanup.
      if (clears > 0) {
        expect(localStorage.getItem(BOOT_RECORD_PREFIX + scope)).toBeNull();
        expect(clearSnapshots).toHaveBeenCalledWith(
          `scope:${JSON.stringify([scope, "cached-account"])}\u0000`,
        );
      } else {
        expect(localStorage.getItem(BOOT_RECORD_PREFIX + scope)).not.toBeNull();
      }
      await vi.dynamicImportSettled();

      publish("connected");
      publish("reconnecting");
      publish("connected");
      await vi.dynamicImportSettled();
      expect(clearSnapshots).toHaveBeenCalledTimes(clears);
    },
  );
});
