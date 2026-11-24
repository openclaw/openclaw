import { defineSettingsPage } from "../define.js";

export const CHANNELS_SETTINGS = defineSettingsPage({
  path: "/settings/channels",
  title: "Channels",
  settings: {
    "channels.*": { label: "Your channels" },
    "channelsPage.setup.*": { label: "Add a channel" },
    "channelsPage.browseAll": { label: "More channels..." },
    "channelsPage.pairingRequests.*": { label: "DM access requests" },
  },
});
