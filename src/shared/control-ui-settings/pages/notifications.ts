import { defineSettingsPage } from "../define.js";

// Push preferences are saved by the Gateway per account and per browser or app, not in config.
export const NOTIFICATIONS_SETTINGS = defineSettingsPage({
  path: "/settings/notifications",
  title: "Notifications",
  settings: {
    "notifications.permission": { label: "Permission" },
    "notifications.pushSubscription": { label: "Status" },
    "notifications.account.categories.*": { label: "Account defaults" },
    "notifications.account.detailLevel": { label: "Lock-screen detail" },
    "notifications.account.quietHours": { label: "Quiet hours" },
    "notifications.account.quietHoursWindow": { label: "Quiet hours window" },
    "notifications.account.timeZone": { label: "Time zone" },
    "notifications.account.agents": { label: "Agents" },
    "notifications.device.enabled": { label: "Deliver to this browser or app" },
    "notifications.device.label": { label: "Notification title prefix" },
    "notifications.device.detailLevel": { label: "Lock-screen detail" },
    "notifications.device.quietHours": { label: "Quiet hours" },
    "notifications.device.quietHoursWindow": { label: "Quiet hours window" },
    "notifications.device.timeZone": { label: "Time zone" },
    "notifications.device.agents": { label: "Agents" },
    "notifications.device.categories.*": { label: "This browser or app" },
  },
});
