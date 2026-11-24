import { defineSettingsPage } from "../define.js";

export const UPDATES_SETTINGS = defineSettingsPage({
  path: "/settings/updates",
  title: "Updates",
  settings: {
    "device.updates.automatic": { label: "Check for updates automatically" },
    "updates.deviceCheck": { label: "Check for updates" },
    "update.channel": { label: "Release channel" },
    "update.checkOnStart": { label: "Check for updates" },
    "update.auto.enabled": { label: "Automatic updates" },
    "update.auto.schedule": { label: "Update schedule" },
    "updates.scheduleTime": { label: "Time of day" },
    "updates.scheduleDay": { label: "Day of the week" },
    "updates.scheduleCron": { label: "Cron expression" },
    "updates.updateNow": { label: "Update Gateway" },
  },
});
