import { defineSettingsPage } from "../define.js";

const advanced = "cloudWorkersPage.advanced";

export const CLOUD_WORKERS_SETTINGS = defineSettingsPage({
  path: "/settings/cloud-workers",
  title: "Cloud environments",
  settings: {
    [advanced]: { label: "Advanced" },
    "cloudWorkers.profiles.*": { label: "Cloud devices", within: advanced },
    "cloudWorkersPage.profile.id": { label: "Profile ID", within: advanced },
    "cloudWorkersPage.profile.backend": { label: "Crabbox backend", within: advanced },
    "cloudWorkersPage.profile.operatingSystem": { label: "Operating system", within: advanced },
    "cloudWorkersPage.profile.machineClass": { label: "Device class", within: advanced },
    "cloudWorkersPage.profile.ttl": { label: "Max lifetime", within: advanced },
    "cloudWorkersPage.profile.idleTimeout": { label: "Idle stop", within: advanced },
    "cloudWorkersPage.profile.setup": { label: "Setup command", within: advanced },
    "cloudWorkersPage.profile.desktop": { label: "Desktop", within: advanced },
    "cloudWorkersPage.profile.binary": { label: "Crabbox binary", within: advanced },
    "cloudWorkersPage.profile.warmImage": { label: "Warm images", within: advanced },
    "cloudWorkersPage.profile.setupEnv": { label: "Setup environment names", within: advanced },
    "cloudWorkersPage.profile.readyWorkers": { label: "Ready cloud devices", within: advanced },
    "cloudWorkersPage.profile.suspendAfter": { label: "Suspend after", within: advanced },
    "cloudWorkers.preparedPool.maxTotal": { label: "Pool limit", within: advanced },
    "cloudWorkersPage.warmImages.refreshAfter": { label: "Refresh after", within: advanced },
    "cloudWorkersPage.warmImages.retainUnused": { label: "Retain unused", within: advanced },
    "cloudWorkersPage.warmImages.keepPrevious": { label: "Previous generations", within: advanced },
  },
});
