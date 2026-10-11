/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createNativeChatDrafts } from "../../app/native-bridge.ts";
import { createNativeConversationBridge } from "../../app/native-conversation-bridge.ts";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { createNativeNotificationsCapability } from "../../app/native-notifications.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import {
  projectNativeChatDrafts,
  projectNativeConversation,
  projectNativeDeviceSettings,
  projectNativeGateways,
  projectNativeNotifications,
} from "./application-native.ts";
import { verifyApplicationProjection } from "./application-test-support.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .toReversed()
    .forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native application projections", () => {
  it("keeps native draft delivery ordered, including the owner's retained draft", () => {
    const createBridge = () => {
      const listeners = new Set<(event: MessageEvent) => void>();
      vi.stubGlobal("chrome", {
        webview: {
          postMessage() {},
          addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
            listeners.add(listener);
          },
          removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
            listeners.delete(listener);
          },
        },
      });
      const source = createNativeChatDrafts();
      cleanups.push(() => source.dispose());
      return {
        source,
        emit: (text: string) =>
          listeners.forEach((listener) =>
            listener(
              new MessageEvent("message", { data: { type: "draft-text", payload: { text } } }),
            ),
          ),
      };
    };
    const first = createBridge();
    first.emit("retained");
    const projection = projectNativeChatDrafts(first.source);
    cleanups.push(() => projection.dispose());
    const received: string[] = [];
    const stop = projection.subscribe((value) => received.push(value));
    first.emit("repeat");
    first.emit("repeat");
    const second = createBridge();
    projection.replaceSource(second.source);
    first.emit("retired");
    second.emit("replacement");
    stop();
    second.emit("next-reader");
    projection.subscribe((value) => received.push(value));
    projection.dispose();
    second.emit("disposed");
    expect(received).toEqual(["retained", "repeat", "repeat", "replacement", "next-reader"]);
  });

  it("projects native settings replies after the owner validates them", async () => {
    await verifyApplicationProjection({
      create: () => {
        const snapshot = createNativeDeviceSettingsSnapshot();
        vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
        vi.stubGlobal("webkit", {
          messageHandlers: {
            openclawDeviceSettings: {
              postMessage: async () => ({
                ...snapshot,
                app: { ...snapshot.app, showDockIcon: false },
              }),
            },
          },
        });
        const source = createNativeDeviceSettingsCapability()!;
        return {
          source,
          update: () =>
            new Promise<void>((resolve, reject) => {
              source.set("app.showDockIcon", false, (error) => (error ? reject(error) : resolve()));
            }),
          dispose: () => source.dispose(),
        };
      },
      project: projectNativeDeviceSettings,
      select: (value) => value?.app?.showDockIcon,
      initial: true,
      updated: false,
    });
  });

  it("projects pending native notification tests without becoming the permission owner", async () => {
    vi.stubGlobal("webkit", {
      messageHandlers: {
        openclawNotifications: {
          postMessage() {},
        },
      },
    });
    await verifyApplicationProjection({
      create: () => {
        const source = createNativeNotificationsCapability()!;
        return { source, update: () => source.sendTest(), dispose: () => source.dispose() };
      },
      project: projectNativeNotifications,
      select: (value) => value.test?.state ?? null,
      initial: null,
      updated: "pending",
    });
  });

  it("rebinds native Gateway readers while preserving its application singleton", async () => {
    // This document singleton has no reset API; load it in this fixture's module epoch.
    vi.resetModules();
    const { nativeGatewaysCapability } = await import("../../app/native-gateways.runtime.ts");
    cleanups.push(() => vi.resetModules());
    const add = vi.spyOn(window, "addEventListener");
    vi.stubGlobal("webkit", {
      messageHandlers: {
        openclawGateways: {
          postMessage() {},
        },
      },
    });
    vi.stubGlobal("__OPENCLAW_NATIVE_GATEWAYS__", { gateways: [], currentId: "first" });
    const source = nativeGatewaysCapability()!;
    // The native singleton intentionally owns this document listener for its whole lifetime.
    for (const [event, listener] of add.mock.calls) {
      if (event === "openclaw:native-gateways-changed") {
        cleanups.push(() => window.removeEventListener(event, listener));
      }
    }
    const subscribe = vi.spyOn(source, "subscribe");
    const projection = projectNativeGateways(source);
    cleanups.push(() => projection.dispose());
    expect(projection.read()?.currentId).toBe("first");
    expect(subscribe).not.toHaveBeenCalled();
    const stop = projection.subscribe(() => {});
    const publish = (currentId: string) =>
      window.dispatchEvent(
        new CustomEvent("openclaw:native-gateways-changed", {
          detail: { gateways: [], currentId },
        }),
      );
    publish("second");
    expect(projection.read()?.currentId).toBe("second");
    projection.replaceSource({
      ...source,
      get snapshot() {
        return source.snapshot;
      },
    });
    expect(subscribe).toHaveBeenCalledTimes(2);
    publish("third");
    expect(projection.read()?.currentId).toBe("third");
    stop();
    projection.dispose();
    publish("fourth");
    expect(projection.read()?.currentId).toBe("third");
    expect(source.snapshot?.currentId).toBe("fourth");
  });

  it("follows accepted native presentation commands across document replacement", async () => {
    const createBridge = () => {
      vi.stubGlobal("__OPENCLAW_NATIVE_EMBED__", {
        platform: "macos",
        formFactor: "desktop",
        surface: "conversation",
      });
      vi.stubGlobal("__OPENCLAW_NATIVE_CONVERSATION__", { contract: 1 });
      vi.stubGlobal("webkit", {
        messageHandlers: {
          openclawConversation: {
            postMessage: async () => ({ ok: true }),
          },
        },
      });
      const subscribe = () => () => {};
      // No route is selected: this fixture exercises native presentation admission only.
      const context = {
        router: { getState: () => ({ matches: [] }), subscribe },
        gateway: { subscribe },
        sessions: { subscribe },
      } as unknown as ApplicationContext;
      const source = createNativeConversationBridge(context)!;
      cleanups.push(() => source.dispose());
      const binding = Reflect.get(window, "__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__") as {
        documentId: string;
      };
      let request = 0;
      return {
        source,
        update: () =>
          new Promise<void>((resolve) => {
            const stop = source.subscribe(() => {
              stop();
              resolve();
            });
            window.dispatchEvent(
              new CustomEvent("openclaw:native-conversation-command", {
                detail: {
                  contract: 1,
                  documentId: binding.documentId,
                  requestId: String(++request),
                  type: "presentation",
                  payload: { visible: false, active: false },
                },
              }),
            );
          }),
      };
    };
    const first = createBridge();
    const projection = projectNativeConversation(first.source);
    cleanups.push(() => projection.dispose());
    const changed = vi.fn();
    projection.subscribe(changed);
    expect(projection.read().presentation).toEqual({ visible: true, active: true });
    await first.update();
    expect(projection.read().presentation).toEqual({ visible: false, active: false });
    const second = createBridge();
    projection.replaceSource(second.source);
    expect(projection.read().presentation).toEqual({ visible: true, active: true });
    await second.update();
    expect(projection.read().presentation).toEqual({ visible: false, active: false });
    projection.dispose();
    changed.mockClear();
    await second.update();
    expect(changed).not.toHaveBeenCalled();
  });
});
