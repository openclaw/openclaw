import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { clearBootRecords, persistBootRecord, type BootRecord } from "./boot-record.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import type { ApplicationGatewayConnectOptions } from "./gateway.ts";
import { loadSettings } from "./settings.ts";

function bootRecord(scope: string, overrides: Partial<BootRecord> = {}): BootRecord {
  return {
    version: 2,
    authMethod: "token",
    credential: "9d17676d",
    recoveryScope: "account-a",
    scope,
    savedAt: Date.now(),
    profileId: "profile-a",
    agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
    groups: [],
    sectionOrder: [],
    ...overrides,
  };
}

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
  const record = bootRecord(gatewayCredentialScope(settings.gatewayUrl), {
    recoveryScope: undefined,
    profileId: "previous-profile",
    groups: [{ name: "Previous profile group", position: 0 }],
    sectionOrder: ["category:Previous profile group"],
  });
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

it("supplies cached identity without authorizing recovery", () => {
  const settings = { ...loadSettings(), token: "" };
  const record = bootRecord(gatewayCredentialScope(settings.gatewayUrl), {
    authMethod: "trusted-proxy",
    credential: "",
  });
  persistBootRecord(record);
  window.dispatchEvent(new Event("pagehide"));
  const { gateway, current } = createGatewayStoreTestStore({ settings });
  gateway.connect();
  expect(current().opts.offlineRecoveryScope).toBe("account-a");
  expect(current().opts.password).toBeUndefined();
  expect(current().opts.token).toBeUndefined();
  expect(gateway.snapshot.phase).toBe("connecting");
  gateway.stop();
});

it.each([
  {
    name: "fresh bootstrap",
    overrides: { bootstrapToken: "synthetic-bootstrap" },
    admitted: false,
  },
  { name: "fresh password", overrides: { password: "synthetic-password" }, admitted: false },
  { name: "same owner", overrides: {}, admitted: true, replacementScope: "account-a" },
  { name: "replacement owner", overrides: {}, admitted: true, replacementScope: "account-b" },
] satisfies Array<{
  name: string;
  overrides: ApplicationGatewayConnectOptions;
  admitted: boolean;
  replacementScope?: string;
}>)(
  "retires only captured admission on rejected $name",
  ({ overrides, admitted, replacementScope }) => {
    const settings = { ...loadSettings(), token: "test-token" };
    const { gateway, current } = createGatewayStoreTestStore({ settings });
    const scope = gatewayCredentialScope(settings.gatewayUrl);
    const saved = bootRecord(scope);
    persistBootRecord(saved);
    window.dispatchEvent(new Event("pagehide"));
    const key = "openclaw.control.bootRecord.v1:" + scope;
    const bytes = localStorage.getItem(key);
    try {
      gateway.connect(overrides);
      expect(current().opts.offlineRecoveryScope).toBe(admitted ? "account-a" : undefined);
      const replacement = { ...saved, recoveryScope: replacementScope };
      if (admitted) {
        persistBootRecord(replacement);
        window.dispatchEvent(new Event("pagehide"));
        persistBootRecord(replacement);
      }
      current().opts.onClose?.({
        code: 4008,
        reason: "rejected",
        willRetry: false,
        error: { code: "PAIRING_REQUIRED", message: "Rejected synthetic admission" },
      });
      if (!admitted) {
        expect(localStorage.getItem(key)).toBe(bytes);
      }
      window.dispatchEvent(new Event("pagehide"));
      expect(localStorage.getItem(key)).toBe(
        !admitted ? bytes : replacementScope === "account-a" ? null : JSON.stringify(replacement),
      );
      expect(gateway.snapshot.phase).toBe("stopped");
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
    const legacy = bootRecord(scope, { recoveryScope: undefined });
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
