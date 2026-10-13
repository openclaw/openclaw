import type { NativeChatDrafts } from "../../app/native-bridge.ts";
import type { NativeConversationBridge } from "../../app/native-conversation-types.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import type { NativeGatewaysCapability } from "../../app/native-gateways.runtime.ts";
import type { NativeNotificationsCapability } from "../../app/native-notifications.ts";
import { projectEvents, projectSource } from "./projection.ts";

export function projectNativeChatDrafts(source: NativeChatDrafts) {
  return projectEvents<NativeChatDrafts, string>(source, {
    subscribe: (drafts, listener) => drafts.subscribe(listener),
  });
}

export function projectNativeConversation(source: NativeConversationBridge) {
  return projectSource(source, {
    read: (conversation) => ({
      presentation: conversation.presentation,
      supportsSessionActions: conversation.supportsSessionActions,
    }),
    subscribe: (conversation, notify) => conversation.subscribe(notify),
    equality: "revision",
  });
}

export function projectNativeDeviceSettings(source: NativeDeviceSettingsCapability) {
  return projectSource(source, {
    read: (settings) => settings.snapshot,
    subscribe: (settings, notify) => settings.subscribe(notify),
    equality: "revision",
  });
}

export function projectNativeNotifications(source: NativeNotificationsCapability) {
  return projectSource(source, {
    read: (notifications) => notifications.snapshot,
    subscribe: (notifications, notify) => notifications.subscribe(notify),
    equality: "revision",
  });
}

export function projectNativeGateways(source: NativeGatewaysCapability) {
  return projectSource(source, {
    read: (gateways) => gateways.snapshot,
    subscribe: (gateways, notify) => gateways.subscribe(notify),
    equality: "revision",
  });
}
