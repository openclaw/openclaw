import { defineSettingsPage } from "../define.js";

export const CHANNELS_SETTINGS = defineSettingsPage({
  path: "/settings/channels",
  title: "Channels",
  settings: {
    // Opens the channel; its config fields keep their own paths.
    "channelsPage.channel.*": { label: "Your channels" },
    "channelsPage.setup.*": { label: "Add a channel" },
    "channelsPage.browseAll": { label: "More channels..." },
    "channelsPage.pairingRequests.*": { label: "DM access requests" },
  },
});
