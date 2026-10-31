import type * as Push from "../../../../packages/gateway-protocol/src/schema/push.js";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import type { NativeDeviceSettingsSnapshot } from "../../app/native-device-settings.ts";
import type { NativeNotificationsCapability } from "../../app/native-notifications.ts";
import type { WebPushSnapshot } from "../../app/web-push.ts";

/** Notification capability props passed from the config page into the notifications section. */
export type NotificationOwnerProps = {
  nativeNotifications: NativeNotificationsCapability["snapshot"] | undefined;
  onNativeNotificationsRequestPermission: () => void;
  onNativeNotificationsSendTest: () => void;
  nativeDeviceSettings?: NativeDeviceSettingsSnapshot | null;
  deviceSettingsHref: string;
  devicePermissionsHref: string;
  onOpenDeviceSettings: () => void;
  onOpenDevicePermissions: () => void;
  webPush: WebPushSnapshot;
  onWebPushSubscribe: () => void;
  onWebPushUnsubscribe: () => void;
  onWebPushTest: () => void;
  onWebPushSetUserPreferences: (preferences: Push.WebPushNotificationPreferences) => void;
  onWebPushSetDevicePreferences: (preferences: Push.WebPushDevicePreferences) => void;
};

export function notificationProps(
  context: ApplicationContext,
  snapshots: {
    nativeNotifications: NativeNotificationsCapability["snapshot"] | undefined;
    nativeDeviceSettings: NativeDeviceSettingsSnapshot | null | undefined;
    webPush: WebPushSnapshot;
  },
): NotificationOwnerProps {
  return {
    nativeNotifications: snapshots.nativeNotifications,
    onNativeNotificationsRequestPermission: () =>
      context.nativeNotifications?.requestPermission(),
    onNativeNotificationsSendTest: () => context.nativeNotifications?.sendTest(),
    nativeDeviceSettings: snapshots.nativeDeviceSettings,
    deviceSettingsHref: pathForRoute("device", context.basePath),
    devicePermissionsHref: pathForRoute("device-permissions", context.basePath),
    onOpenDeviceSettings: () => context.navigate("device"),
    onOpenDevicePermissions: () => context.navigate("device-permissions"),
    webPush: snapshots.webPush,
    onWebPushSubscribe: () => void context.webPush.run({ kind: "enable" }),
    onWebPushUnsubscribe: () => void context.webPush.run({ kind: "disable" }),
    onWebPushTest: () => void context.webPush.run({ kind: "test" }),
    onWebPushSetUserPreferences: (preferences) =>
      void context.webPush.run({ kind: "set", scope: "user", preferences }),
    onWebPushSetDevicePreferences: (preferences) =>
      void context.webPush.run({ kind: "set", scope: "device", preferences }),
  };
}
