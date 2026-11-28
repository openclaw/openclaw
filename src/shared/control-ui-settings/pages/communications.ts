import { defineSettingsPage } from "../define.js";

export const COMMUNICATIONS_SETTINGS = defineSettingsPage({
  path: "/settings/communications",
  title: "Communications",
  settings: {
    "transcripts.enabled": { label: "Enable transcript storage" },
    "communications.transcriptLibrary": { label: "Transcript library", section: "transcripts" },
    // One row per configured source, by its place in the list.
    "communications.meetingSources.*": { label: "Auto-start source", section: "transcripts" },
    "communications.meetingSourceProvider": { label: "Provider", section: "transcripts" },
    "communications.meetingSourceField.*": { label: "Source field", section: "transcripts" },
    "communications.meetingCaptureAdvanced": { label: "Advanced settings", section: "transcripts" },
  },
});
