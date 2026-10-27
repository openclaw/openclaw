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
import { makeBootRecord, makeBootRoster, makeLocation } from "./bootstrap.test-support.ts";
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
function captureGatewayConnection(fields: () => object, revision?: () => number) {
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const createGateway = gatewayStore.createApplicationGateway;
  let current: ReturnType<typeof createGateway>;
  vi.spyOn(gatewayStore, "createApplicationGateway").mockImplementation((...args) => {
    const gateway = createGateway(...args);
    current = gateway;
    if (revision) {
      vi.spyOn(gateway, "connectionRevision", "get").mockImplementation(revision);
    }
    vi.spyOn(gateway, "subscribe").mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    return gateway;
  });
  return (phase: ApplicationGatewaySnapshot["phase"]) => {
    const snapshot = Object.assign(current.snapshot, fields(), { phase });
    listeners.forEach((listener) => listener(snapshot));
  };
}

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";

function seedBootRecord(overrides: Partial<BootRecord> = {}): BootRecord {
  const record = makeBootRecord(gatewayCredentialScope(loadSettings().gatewayUrl), overrides);
  localStorage.setItem(BOOT_RECORD_PREFIX + record.scope, JSON.stringify(record));
  return record;
}
function expectDefaults(runtime: ReturnType<typeof createApplication>, scope = "per-sender") {
  expect(runtime.context.offlineSessionDefaults).toEqual({ mainKey: "workspace", scope });
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
    vi.unstubAllGlobals();
  });

  it("admits a previously signed-in trusted-proxy account before server connection", async () => {
    window.history.replaceState({}, "", "/chat/main");
    persistSessionToken(loadSettings().gatewayUrl, "");
    seedBootRecord({
      authMethod: "trusted-proxy",
      credential: "",
      recoveryScope: "account-a",
      agents: makeBootRoster({ mainKey: "workspace" }),
    });
    const runtime = bootstrapApplication();
    expect(runtime.warmBoot).toBe(true);
    const { gateway, agents } = runtime.context;
    expect(gateway.snapshot).toMatchObject({ phase: "stopped", hello: null });
    const client = new GatewayBrowserClient({
      url: loadSettings().gatewayUrl,
      offlineRecoveryScope: "account-a",
    });
    const request = vi.spyOn(client, "request");
    gateway.snapshot.client = client;
    expect(agents.state.agentsList).toBeNull();
    expectDefaults(runtime);
    const signal = new AbortController().signal;
    await expect(
      loadChatRoute(runtime.context, makeLocation("/chat/main"), "chat", signal),
    ).resolves.toMatchObject({ kind: "session", sessionKey: "agent:main:workspace" });
    expect(request).not.toHaveBeenCalled();
    expect(agents.state.agentsList).toBeNull();
    gateway.snapshot.phase = "connected";
    expect(runtime.context.offlineSessionDefaults).toBeNull();
    gateway.snapshot.phase = "reconnecting";
    gateway.snapshot.client = new GatewayBrowserClient({
      url: loadSettings().gatewayUrl,
      offlineRecoveryScope: "another-account",
    });
    expect(runtime.context.offlineSessionDefaults).toBeNull();
    gateway.snapshot.client = client;
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
    fixture.current().testOptions.onClose?.({
      code: 4008,
      reason: "pairing required",
      willRetry: true,
      error: { code: "PAIRING_REQUIRED", message: "Pairing required" },
    });
    expect(runtime.warmBoot).toBe(false);
    fixture
      .current()
      .testOptions.onClose?.({ code: 1006, reason: "network unavailable", willRetry: true });
    expect(fixture.gateway.snapshot.lastErrorCode).toBeNull();
    expect(runtime.warmBoot).toBe(false);
    expect(localStorage.getItem(BOOT_RECORD_PREFIX + scope)).toBeNull();
    expect(sessionStorage.getItem("retained-draft")).toBe("Keep this draft");
  });

  it("keeps a version2 roster private until live discovery and retains that discovery on reconnect failure", async () => {
    const record = seedBootRecord({
      recoveryScope: "test-recovery-scope",
      agents: makeBootRoster({
        defaultId: "private",
        agents: [{ id: "private", name: "Private agent" }, { id: "shared" }],
      }),
      groups: [{ name: "Personal", position: 0 }],
      sectionOrder: ["Personal"],
    });
    const discovery = createDeferred<AgentsListResult>();
    const discover = vi.fn(() => discovery.promise);
    const request = vi.fn(async (method: string) => (method === "agents.list" ? discover() : {}));
    const client = createTestGatewayClient(request);
    const publish = captureGatewayConnection(() => ({
      client,
      selfUser: { id: "profile-a" },
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: { method: "token", recoveryScope: "test-recovery-scope" },
      },
    }));
    const runtime = bootstrapApplication();
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
    const confirmed = agents.state.agentsList;

    publish("reconnecting");
    expect(agents.state.agentsList).toBe(confirmed);
    expectDefaults(runtime, "global");
    discover.mockRejectedValue(new Error("roster unavailable"));
    publish("connected");
    await agents.ensureList();
    expect(agents.state.agentsList).toBe(confirmed);
    expect(agents.state.agentsError).toContain("roster unavailable");
  });

  it.each([
    { profileId: "profile-b", clears: 1, credentialsChanged: false },
    { profileId: "profile-a", clears: 0, credentialsChanged: false },
    { profileId: "profile-b", clears: 0, credentialsChanged: true },
  ])(
    "clears $clears times for connected $profileId (credential change: $credentialsChanged)",
    async ({ profileId, clears, credentialsChanged }) => {
      window.history.replaceState({}, "", "/chat");
      const { scope } = seedBootRecord({ recoveryScope: "cached-account" });
      const clearSnapshots = vi.spyOn(snapshots, "clearStoredChatSnapshots").mockResolvedValue();
      let connectionRevision = 0;
      const publish = captureGatewayConnection(
        () => ({
          hello: {
            type: "hello-ok",
            protocol: 1,
            auth: {
              method: "token",
              recoveryScope: profileId === "profile-a" ? "cached-account" : "replacement-account",
            },
          },
          selfUser: { id: profileId },
        }),
        () => connectionRevision,
      );
      const runtime = bootstrapApplication();
      expect(runtime.warmBoot).toBe(true);
      if (credentialsChanged) {
        connectionRevision += 1;
      }
      publish("connecting");
      expect(clearSnapshots).not.toHaveBeenCalled();

      publish("connected");
      expect(clearSnapshots).toHaveBeenCalledTimes(clears);
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
