import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { clearBootRecords, persistBootRecord, type BootRecord } from "./boot-record.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import { loadSettings } from "./settings.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(async () => {
  clearBootRecords();
  await vi.dynamicImportSettled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("clears persisted and pending warm state before yielding or pagehide", async () => {
  const settings = { ...loadSettings(), token: "test-token" };
  const { gateway } = createGatewayStoreTestStore({ settings });
  const record: BootRecord = {
    version: 2,
    authMethod: "token",
    credential: "9d17676d",
    scope: gatewayCredentialScope(settings.gatewayUrl),
    savedAt: Date.now(),
    profileId: "previous-profile",
    agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
    groups: [{ name: "Previous profile group", position: 0 }],
    sectionOrder: ["category:Previous profile group"],
  };
  const key = "openclaw.control.bootRecord.v1:" + record.scope;
  try {
    gateway.connect();
    persistBootRecord(record);
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(key)).not.toBeNull();
    persistBootRecord({ ...record, sectionOrder: [] });
    gateway.connect();
    expect(localStorage.getItem(key)).not.toBeNull();
    gateway.connect({ token: "replacement-token" });
    expect(localStorage.getItem(key)).toBeNull();
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(key)).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(localStorage.getItem(key)).toBeNull();
  } finally {
    gateway.stop();
  }
});

it.each(["trusted-proxy", "tailscale", "password"])(
  "supplies %s cached identity without authorizing recovery",
  async (authMethod) => {
    const settings = { ...loadSettings(), token: "" };
    const record: BootRecord = {
      version: 2,
      authMethod,
      credential: "",
      recoveryScope: "account-a",
      scope: gatewayCredentialScope(settings.gatewayUrl),
      savedAt: Date.now(),
      profileId: "profile-a",
      agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
      groups: [],
      sectionOrder: [],
    };
    persistBootRecord(record);
    window.dispatchEvent(new Event("pagehide"));
    const { gateway, current } = createGatewayStoreTestStore({ settings });
    gateway.connect();
    expect(current().opts.offlineRecoveryScope).toBe("account-a");
    expect(current().opts.password).toBeUndefined();
    expect(current().opts.token).toBeUndefined();
    expect(gateway.snapshot.phase).toBe("connecting");
    gateway.stop();
  },
);

it.each([{ bootstrapToken: "synthetic-bootstrap" }, { password: "synthetic-password" }])(
  "does not retire an admitted peer on a fresh rejected connection %j",
  (overrides) => {
    const settings = { ...loadSettings(), token: "test-token" };
    const { gateway, current } = createGatewayStoreTestStore({ settings });
    const scope = gatewayCredentialScope(settings.gatewayUrl);
    const saved: BootRecord = {
      version: 2,
      authMethod: "token",
      credential: "9d17676d",
      recoveryScope: "peer-account",
      scope,
      savedAt: Date.now(),
      profileId: "profile-a",
      agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
      groups: [],
      sectionOrder: [],
    };
    persistBootRecord(saved);
    window.dispatchEvent(new Event("pagehide"));
    const key = "openclaw.control.bootRecord.v1:" + scope;
    const bytes = localStorage.getItem(key);
    try {
      gateway.connect(overrides);
      expect(current().opts.offlineRecoveryScope).toBeUndefined();
      current().opts.onClose?.({
        code: 4008,
        reason: "rejected",
        willRetry: false,
        error: { code: "PAIRING_REQUIRED", message: "Rejected synthetic admission" },
      });
      expect(localStorage.getItem(key)).toBe(bytes);
      expect(gateway.snapshot.phase).toBe("stopped");
    } finally {
      gateway.stop();
    }
  },
);

it.each(["same-owner", "replacement-owner"])(
  "retires only captured admission after %s rejection",
  (which) => {
    const settings = { ...loadSettings(), token: "test-token" };
    const scope = gatewayCredentialScope(settings.gatewayUrl);
    const saved: BootRecord = {
      version: 2,
      authMethod: "token",
      credential: "9d17676d",
      recoveryScope: "account-a",
      scope,
      savedAt: Date.now(),
      profileId: "same-profile",
      agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
      groups: [],
      sectionOrder: [],
    };
    persistBootRecord(saved);
    window.dispatchEvent(new Event("pagehide"));
    const { gateway, current } = createGatewayStoreTestStore({ settings });
    try {
      gateway.connect();
      expect(current().opts.offlineRecoveryScope).toBe("account-a");
      const replacement = {
        ...saved,
        recoveryScope: which === "same-owner" ? "account-a" : "account-b",
      };
      persistBootRecord(replacement);
      window.dispatchEvent(new Event("pagehide"));
      persistBootRecord(replacement);
      current().opts.onClose?.({
        code: 4008,
        reason: "rejected",
        willRetry: false,
        error: { code: "PAIRING_REQUIRED", message: "Rejected synthetic admission" },
      });
      window.dispatchEvent(new Event("pagehide"));
      const stored = localStorage.getItem("openclaw.control.bootRecord.v1:" + scope);
      expect(stored && JSON.parse(stored)).toEqual(which === "same-owner" ? null : replacement);
    } finally {
      gateway.stop();
    }
  },
);

it.each(["rejection", "credential edit"])(
  "retires captured legacy and live owners after hello on %s",
  (transition) => {
    const settings = { ...loadSettings(), token: "test-token" };
    const scope = gatewayCredentialScope(settings.gatewayUrl);
    const key = "openclaw.control.bootRecord.v1:" + scope;
    const legacy: BootRecord = {
      version: 2,
      authMethod: "token",
      credential: "9d17676d",
      scope,
      savedAt: Date.now(),
      profileId: "profile-a",
      agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
      groups: [],
      sectionOrder: [],
    };
    for (const published of ["legacy", "live", "peer"] as const) {
      localStorage.setItem(key, JSON.stringify(legacy));
      const { gateway, current } = createGatewayStoreTestStore({ settings });
      try {
        gateway.connect();
        current().opts.onHello?.({
          type: "hello-ok",
          protocol: 1,
          auth: { method: "token", role: "operator", scopes: [], recoveryScope: "live-owner" },
          snapshot: { authMode: "token" },
        });
        const replacement =
          published === "legacy"
            ? legacy
            : { ...legacy, recoveryScope: published === "live" ? "live-owner" : "peer-owner" };
        localStorage.setItem(key, JSON.stringify(replacement));
        persistBootRecord(replacement);
        if (transition === "rejection") {
          current().opts.onClose?.({
            code: 4008,
            reason: "rejected",
            willRetry: false,
            error: { code: "PAIRING_REQUIRED", message: "Rejected admitted owner" },
          });
        } else {
          gateway.connect({ token: "replacement-token" });
        }
        window.dispatchEvent(new Event("pagehide"));
        expect(localStorage.getItem(key), published).toBe(
          published === "peer" ? JSON.stringify(replacement) : null,
        );
      } finally {
        gateway.stop();
      }
    }
  },
);
