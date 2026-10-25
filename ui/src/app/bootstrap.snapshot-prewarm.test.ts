import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { storeDeviceAuthToken } from "../lib/nodes/index.ts";
import * as prewarm from "../pages/chat/session-snapshot-prewarm.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { makeBootRecord as bootRecord, makeBootRoster } from "./bootstrap.test-support.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import { loadSettings, persistSessionToken, saveSettings } from "./settings.ts";

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";

beforeEach(() => {
  const previousUrl = window.location.href;
  onTestFinished(() => window.history.replaceState({}, "", previousUrl));
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});

function configure(patch: Partial<ReturnType<typeof loadSettings>>, token = "test-token") {
  const settings = { ...loadSettings(), ...patch };
  saveSettings(settings);
  persistSessionToken(settings.gatewayUrl, token);
  return settings;
}

function spyPrewarm() {
  return vi.spyOn(prewarm, "prewarmChatSnapshot").mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  {
    key: "agent:other:conversation",
    url: "/chat",
    expected: "agent:other:conversation",
  },
  { key: "agent:other:conversation", url: "/settings", expected: null },
  {
    key: "agent:main:dashboard:12345678-90ab-4def-8234-567890abcdef",
    url: "/dashboard/main/mission-control",
    expected: "agent:main:dashboard:12345678-90ab-4def-8234-567890abcdef",
  },
  {
    key: "agent:main:dashboard:12345678-90ab-4def-8234-567890abcdef",
    url: "/dashboard/main/~key/mission-control",
    expected: "agent:main:mission-control",
  },
  {
    key: "agent:other:dashboard:12345678-90ab-4def-8234-567890abcdef",
    url: "/dashboard/main/mission-control",
    expected: "agent:main:mission-control",
  },
  {
    key: "agent:main:dashboard:12345678-90ab-4def-8234-567890abcdef",
    url: "/chat/main/new-topic",
    expected: "agent:main:new-topic",
  },
  { key: "agent:other:conversation", url: "/chat/main", expected: "agent:main:main" },
  {
    key: "agent:other:conversation",
    url: "/chat/main/new-topic",
    expected: "agent:main:new-topic",
  },
  {
    key: "agent:other:conversation",
    url: "/chat/main/1234567890abcdef1234567890abcdef",
    expected: null,
  },
  {
    key: "agent:main:main",
    url: "/chat?gatewayUrl=ws%3A%2F%2Fanother.example",
    expected: null,
  },
])("prewarms $key at $url only when warm boot permits it", async ({ key, url, expected }) => {
  const settings = configure({ sessionKey: key, lastActiveSessionKey: key });
  const record = bootRecord(gatewayCredentialScope(settings.gatewayUrl), {
    recoveryScope: "account-a",
    profileId: null,
    agents: makeBootRoster({
      mainKey: "custom-main",
      agents: [{ id: "main" }, { id: "other" }],
    }),
  });
  localStorage.setItem(BOOT_RECORD_PREFIX + record.scope, JSON.stringify(record));
  window.history.replaceState({}, "", url);
  const startRead = spyPrewarm();
  const runtime = bootstrapApplication();
  onTestFinished(() => runtime.stop());
  try {
    if (expected) {
      expect(startRead).toHaveBeenCalledExactlyOnceWith(
        `scope:${JSON.stringify([record.scope, "account-a"])}\u0000${expected}`,
      );
    } else {
      expect(startRead).not.toHaveBeenCalled();
    }
    expect(runtime.context.gateway.snapshot.phase).not.toBe("connected");
  } finally {
    await prewarm.readSidebarBootSnapshot(runtime.context.gateway);
  }
});
it.each([
  { authMethod: "token", token: "changed-token", warm: false, retained: true },
  { authMethod: "token", token: "", warm: false, retained: true },
  { authMethod: "device-token", token: "", warm: true, retained: true },
  { authMethod: "device-token", token: "new-operator-token", warm: false, retained: true },
  { authMethod: "trusted-proxy", token: "test-token", warm: false, retained: false },
])(
  "$authMethod boot with operator '$token' and device 'test-token' is warm: $warm",
  ({ authMethod, token, warm, retained }) => {
    window.history.replaceState({}, "", "/chat");
    const settings = configure({ sessionKey: "agent:main:main" }, token);
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({
        version: 1,
        deviceId: "device-one",
        publicKey: "public",
        privateKey: "private",
      }),
    );
    storeDeviceAuthToken({
      deviceId: "device-one",
      gatewayUrl: settings.gatewayUrl,
      role: "operator",
      token: "test-token",
      scopes: ["operator.read"],
    });
    const scope = gatewayCredentialScope(settings.gatewayUrl);
    localStorage.setItem(
      BOOT_RECORD_PREFIX + scope,
      JSON.stringify(bootRecord(scope, { authMethod })),
    );
    const savedRecord = localStorage.getItem(BOOT_RECORD_PREFIX + scope);
    const startRead = spyPrewarm();
    const runtime = bootstrapApplication();
    onTestFinished(() => runtime.stop());
    expect(runtime.warmBoot).toBe(warm);
    expect(startRead).toHaveBeenCalledTimes(warm ? 1 : 0);
    expect(runtime.context.agents.state.agentsList).toBeNull();
    // Non-admission preserves a valid peer record; malformed records still retire.
    expect(localStorage.getItem(BOOT_RECORD_PREFIX + scope)).toBe(retained ? savedRecord : null);
  },
);
