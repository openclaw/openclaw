export type NotificationEventFamily = "reactions";

export type NotificationWakePolicy = "off" | "queue" | "wake";

export type NotificationWakePolicySetting = NotificationWakePolicy | "inherit";

export type NotificationWakePolicyConfig = Partial<
  Record<NotificationEventFamily, NotificationWakePolicySetting>
>;

export type NotificationsConfig = {
  /** Default policy for queued notification-backed system events. */
  systemEvents?: NotificationWakePolicyConfig;
};
