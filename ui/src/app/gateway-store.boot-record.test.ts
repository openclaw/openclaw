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
