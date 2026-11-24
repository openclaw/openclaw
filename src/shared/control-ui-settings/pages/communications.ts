import { defineSettingsPage } from "../define.js";

export const COMMUNICATIONS_SETTINGS = defineSettingsPage({
  path: "/settings/communications",
  title: "Communications",
  settings: {
    "transcripts.enabled": { label: "Enable transcript storage" },
    "communications.transcriptLibrary": { label: "Transcript library" },
    // One row per configured source, by its place in the list.
    "communications.meetingSources.*": { label: "Auto-start source" },
    "communications.meetingSourceProvider": { label: "Provider" },
    "communications.meetingSourceField.*": { label: "Source field" },
    "communications.meetingCaptureAdvanced": { label: "Advanced settings" },
  },
});
