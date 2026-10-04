import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import { clearCachedBootState } from "../lib/sessions/session-roster-cache.runtime.ts";
import { loadChatRoute } from "../pages/chat/route-loader.ts";
import * as snapshots from "../pages/chat/session-snapshot-invalidation.runtime.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { clearBootRecords, type BootRecord } from "./boot-record.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import * as gatewayStore from "./gateway-store.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

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

vi.mock("../lib/sessions/session-roster-cache.runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sessions/session-roster-cache.runtime.ts")>()),
  clearCachedBootState: vi.fn(async () => undefined),
}));

describe("warm boot profile validation", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    persistSessionToken(loadSettings().gatewayUrl, "test-token");
  });
  afterEach(() => {
    clearBootRecords();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["trusted-proxy", "tailscale", "password"] as const)(
    "admits a previously signed-in %s account before server connection",
    async (authMethod) => {
      const previousUrl = window.location.href;
      window.history.replaceState({}, "", "/chat/main");
      persistSessionToken(loadSettings().gatewayUrl, "");
      seedBootRecord({
        authMethod,
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
      try {
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
      } finally {
        runtime.stop();
        window.history.replaceState({}, "", previousUrl);
      }
    },
  );

  it("does not revive warm admission after pairing rejection followed by network loss", () => {
    const previousUrl = window.location.href;
    window.history.replaceState({}, "", "/chat");
    const { scope } = seedBootRecord({ profileId: null });
    sessionStorage.setItem("retained-draft", "Keep this draft");
    const fixture = createGatewayStoreTestStore();
    vi.spyOn(gatewayStore, "createApplicationGateway").mockReturnValue(fixture.gateway);
    const runtime = bootstrapApplication();
    try {
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
    } finally {
      runtime.stop();
      window.history.replaceState({}, "", previousUrl);
    }
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
    const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
    const createGateway = gatewayStore.createApplicationGateway;
    vi.spyOn(gatewayStore, "createApplicationGateway").mockImplementation((...args) => {
      const gateway = createGateway(...args);
      vi.spyOn(gateway, "subscribe").mockImplementation((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      });
      return gateway;
    });
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
      for (const listener of listeners) {
        listener(snapshot);
      }
    };
    try {
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
    } finally {
      runtime.stop();
    }
  });

  it.each([
    ...[
      { cachedProfileId: "profile-a", profileId: "profile-b", clears: 1 },
      { cachedProfileId: "profile-a", profileId: null, clears: 1 },
      { cachedProfileId: null, profileId: "profile-b", clears: 1 },
      { cachedProfileId: "profile-a", profileId: "profile-a", clears: 0 },
      { cachedProfileId: null, profileId: null, clears: 0 },
      { cachedProfileId: "profile-a", profileId: "profile-b", clears: 0, credentialsChanged: true },
    ].map((entry) => Object.assign(entry, { pathname: "/chat", warmBoot: true })),
    ...["/focus/terminal", "/approve/exec%3A1"].map((pathname) => ({
      cachedProfileId: "profile-a",
      profileId: "profile-b",
      clears: 0,
      pathname,
      warmBoot: false,
      credentialsChanged: false,
    })),
  ])(
    "clears $clears times for cached $cachedProfileId and connected $profileId on $pathname (credential change: $credentialsChanged)",
    async ({ cachedProfileId, profileId, clears, pathname, warmBoot, credentialsChanged }) => {
      const previousUrl = window.location.href;
      window.history.replaceState({}, "", pathname);
      const { scope } = seedBootRecord({
        profileId: cachedProfileId,
        recoveryScope: "cached-account",
      });
      const clearSnapshots = vi.spyOn(snapshots, "clearStoredChatSnapshots").mockResolvedValue();
      const clearRoster = vi.mocked(clearCachedBootState);
      const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
      let connectionRevision = 0;
      const createGateway = gatewayStore.createApplicationGateway;
      vi.spyOn(gatewayStore, "createApplicationGateway").mockImplementation((...args) => {
        const gateway = createGateway(...args);
        vi.spyOn(gateway, "connectionRevision", "get").mockImplementation(() => connectionRevision);
        vi.spyOn(gateway, "subscribe").mockImplementation((listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        });
        return gateway;
      });
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
          selfUser: profileId === null ? null : { id: profileId },
        });
        for (const listener of listeners) {
          listener(snapshot);
        }
      };
      try {
        expect(runtime.warmBoot).toBe(warmBoot);
        if (credentialsChanged) {
          connectionRevision += 1;
        }
        publish("connecting");
        expect(clearSnapshots).not.toHaveBeenCalled();
        expect(clearRoster).not.toHaveBeenCalled();

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
        expect(clearRoster).toHaveBeenCalledTimes(clears);

        publish("connected");
        publish("reconnecting");
        publish("connected");
        await vi.dynamicImportSettled();
        expect(clearSnapshots).toHaveBeenCalledTimes(clears);
        expect(clearRoster).toHaveBeenCalledTimes(clears);
      } finally {
        runtime.stop();
        window.history.replaceState({}, "", previousUrl);
      }
    },
  );
});
