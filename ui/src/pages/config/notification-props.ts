import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { NotificationsSectionProps } from "./notifications-section.tsx";

export function notificationProps(
  context: ApplicationContext,
): Omit<NotificationsSectionProps, "connected"> {
  return {
    nativeNotifications: context.nativeNotifications?.snapshot,
    onNativeNotificationsRequestPermission: () => context.nativeNotifications?.requestPermission(),
    onNativeNotificationsSendTest: () => context.nativeNotifications?.sendTest(),
    nativeDeviceSettings: context.nativeDeviceSettings?.snapshot,
    deviceSettingsHref: pathForRoute("device", context.basePath),
    devicePermissionsHref: pathForRoute("device-permissions", context.basePath),
    onOpenDeviceSettings: () => context.navigate("device"),
    onOpenDevicePermissions: () => context.navigate("device-permissions"),
    webPush: context.webPush.snapshot,
    onWebPushSubscribe: () => void context.webPush.run({ kind: "enable" }),
    onWebPushUnsubscribe: () => void context.webPush.run({ kind: "disable" }),
    onWebPushTest: () => void context.webPush.run({ kind: "test" }),
    onWebPushSetUserPreferences: (preferences) =>
      void context.webPush.run({ kind: "set", scope: "user", preferences }),
    onWebPushSetDevicePreferences: (preferences) =>
      void context.webPush.run({ kind: "set", scope: "device", preferences }),
  };
}
