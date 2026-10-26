/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  autoPromptNotificationsOnSend,
  hasActiveNotificationPromptGesture,
  shouldAutoPromptNotificationsOnSend,
} from "./notifications-auto-prompt.ts";

const STORAGE_KEY = "openclaw.control.notificationsAutoPrompt.v1";

type AutoPromptContext = Parameters<typeof autoPromptNotificationsOnSend>[0];
type NativePermission = "granted" | "denied" | "notDetermined" | "unknown";

let storage: Storage;
let browserRequestPermission: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storage = createStorageMock();
  vi.stubGlobal("localStorage", storage);
  browserRequestPermission = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
  vi.stubGlobal("Notification", { requestPermission: browserRequestPermission });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createContext(
  overrides: {
    supported?: boolean;
    canManage?: boolean;
    permission?: NotificationPermission | "unsupported";
    subscription?: AutoPromptContext["webPush"]["snapshot"]["subscription"];
    loading?: boolean;
    nativePermission?: NativePermission | null;
  } = {},
) {
  const enable = vi.fn(async () => undefined);
  const requestPermission = vi.fn();
  const nativePermission = overrides.nativePermission ?? null;
  const context = {
    nativeNotifications:
      nativePermission === null
        ? null
        : { snapshot: { permission: nativePermission }, requestPermission },
    webPush: {
      snapshot: {
        supported: overrides.supported ?? true,
        canManage: overrides.canManage ?? true,
        canReadPreferences: true,
        permission: overrides.permission ?? "default",
        subscription: overrides.subscription ?? "unknown",
        loading: overrides.loading ?? false,
        error: null,
      },
      run: enable,
    },
  } as unknown as AutoPromptContext;
  return { context, enable, requestPermission };
}

describe("notification auto-prompt", () => {
  it("requests browser permission synchronously and enables web push only once", async () => {
    const { context, enable } = createContext();

    autoPromptNotificationsOnSend(context);
    autoPromptNotificationsOnSend(context);

    expect(browserRequestPermission).toHaveBeenCalledOnce();
    expect(enable).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(enable).toHaveBeenCalledOnce();
    expect(storage.getItem(STORAGE_KEY)).toBe("1");
  });

  it.each([
    ["loading", { loading: true }],
    ["Gateway access denied", { canManage: false }],
  ])("does not enable web push when it is %s", (_name, overrides) => {
    const { context, enable } = createContext(overrides);

    autoPromptNotificationsOnSend(context);

    expect(enable).not.toHaveBeenCalled();
    expect(browserRequestPermission).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("prefers the native permission flow when permission is not determined", () => {
    const { context, enable, requestPermission } = createContext({
      nativePermission: "notDetermined",
    });

    autoPromptNotificationsOnSend(context);

    expect(requestPermission).toHaveBeenCalledOnce();
    expect(enable).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("does not request native permission when it is denied", () => {
    const { context, enable, requestPermission } = createContext({ nativePermission: "denied" });

    autoPromptNotificationsOnSend(context);

    expect(requestPermission).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("fails closed when the localStorage getter throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("opaque origin");
      },
    });
    const { context, enable, requestPermission } = createContext({
      nativePermission: "notDetermined",
    });

    expect(() => autoPromptNotificationsOnSend(context)).not.toThrow();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
  });
});

describe("notification auto-prompt send boundary", () => {
  const candidate = {
    connected: true,
    directComposerSend: true,
    message: "hello",
    hasAttachments: false,
    isCommand: false,
  };

  it("recognizes only the synchronous browser event dispatch", async () => {
    const button = document.createElement("button");
    let duringDispatch = false;
    let afterDispatch = true;
    button.addEventListener("click", () => {
      duringDispatch = hasActiveNotificationPromptGesture();
      queueMicrotask(() => {
        afterDispatch = hasActiveNotificationPromptGesture();
      });
    });

    button.click();
    await Promise.resolve();

    expect(duringDispatch).toBe(true);
    expect(afterDispatch).toBe(false);
  });

  it.each([["empty composer", { message: "" }]])("rejects a %s", (_name, override) => {
    expect(shouldAutoPromptNotificationsOnSend({ ...candidate, ...override })).toBe(false);
  });
});
