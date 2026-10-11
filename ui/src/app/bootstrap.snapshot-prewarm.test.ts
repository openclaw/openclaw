import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeDeviceAuthToken } from "../lib/nodes/index.ts";
import * as prewarm from "../pages/chat/session-snapshot-prewarm.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import type { BootRecord } from "./boot-record.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import { loadSettings, persistSessionToken, saveSettings } from "./settings.ts";

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bootstrap routed snapshot prewarm", () => {
  it.each([
    {
      key: "agent:other:conversation",
      boot: true,
      url: "/chat",
      expected: "agent:other:conversation",
    },
    {
      key: "agent:main:main",
      boot: true,
      url: "/chat?gatewayUrl=ws%3A%2F%2Fanother.example",
      expected: null,
    },
  ])("prewarms $key at $url only when warm boot permits it", ({ key, boot, url, expected }) => {
    const previousUrl = window.location.href;
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    const settings = {
      ...loadSettings(),
      sessionKey: key,
      lastActiveSessionKey: key,
    };
    saveSettings(settings);
    persistSessionToken(settings.gatewayUrl, "test-token");
    const record: BootRecord = {
      version: 2,
      recoveryScope: "account-a",
      authMethod: "token",
      credential: "9d17676d",
      scope: gatewayCredentialScope(settings.gatewayUrl),
      savedAt: Date.now(),
      profileId: null,
      agents: {
        defaultId: "main",
        mainKey: "custom-main",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "other" }],
      },
      groups: [],
      sectionOrder: [],
    };
    if (boot) {
      localStorage.setItem(BOOT_RECORD_PREFIX + record.scope, JSON.stringify(record));
    }
    window.history.replaceState({}, "", url);
    const startRead = vi.spyOn(prewarm, "prewarmChatSnapshot").mockImplementation(() => undefined);
    const runtime = bootstrapApplication();
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
      runtime.stop();
      window.history.replaceState({}, "", previousUrl);
    }
  });
});

describe("warm startup credential binding", () => {
  it.each([
    {
      authMethod: "token",
      token: "changed-token",
      deviceToken: "test-token",
      warm: false,
      retained: true,
    },
    { authMethod: "token", token: "", deviceToken: "test-token", warm: false, retained: true },
    {
      authMethod: "device-token",
      token: "",
      deviceToken: "test-token",
      warm: true,
      retained: true,
    },
    {
      authMethod: "device-token",
      token: "new-operator-token",
      deviceToken: "test-token",
      warm: false,
      retained: true,
    },
    {
      authMethod: "trusted-proxy",
      token: "test-token",
      deviceToken: "test-token",
      warm: false,
      retained: false,
    },
  ])(
    "$authMethod boot with operator '$token' and device '$deviceToken' is warm: $warm",
    ({ authMethod, token, deviceToken, warm, retained }) => {
      const previousUrl = window.location.href;
      window.history.replaceState({}, "", "/chat");
      vi.stubGlobal("localStorage", createStorageMock());
      vi.stubGlobal("sessionStorage", createStorageMock());
      const settings = { ...loadSettings(), sessionKey: "agent:main:main" };
      saveSettings(settings);
      persistSessionToken(settings.gatewayUrl, token);
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
        token: deviceToken,
        scopes: ["operator.read"],
      });
      const scope = gatewayCredentialScope(settings.gatewayUrl);
      localStorage.setItem(
        BOOT_RECORD_PREFIX + scope,
        JSON.stringify({
          version: 2,
          authMethod,
          credential: "9d17676d",
          savedAt: Date.now(),
          scope,
          profileId: "profile-a",
          agents: {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main" }],
          },
          groups: [],
          sectionOrder: [],
        }),
      );
      const savedRecord = localStorage.getItem(BOOT_RECORD_PREFIX + scope);
      const startRead = vi
        .spyOn(prewarm, "prewarmChatSnapshot")
        .mockImplementation(() => undefined);
      const runtime = bootstrapApplication();
      try {
        expect(runtime.warmBoot).toBe(warm);
        expect(startRead).toHaveBeenCalledTimes(warm ? 1 : 0);
        expect(runtime.context.agents.state.agentsList).toBeNull();
        // Credential non-admission preserves a valid peer record; malformed records still retire.
        expect(localStorage.getItem(BOOT_RECORD_PREFIX + scope)).toBe(
          retained ? savedRecord : null,
        );
      } finally {
        runtime.stop();
        window.history.replaceState({}, "", previousUrl);
      }
    },
  );
});
