import { defineSettingsPage } from "../define.js";

export const TALK_SETTINGS = defineSettingsPage({
  path: "/settings/talk",
  title: "Talk",
  settings: {
    // Voice controls of the native app, one row per switch it reports.
    "device.voice.*": { label: "Voice setting" },
    "device.voice.microphone": { label: "Microphone" },
    "device.voice.locale.primary": { label: "Primary language" },
    "device.voice.locale.additional": { label: "Additional languages" },
    "talkPage.microphoneTest": { label: "Test microphone" },
    "talkPage.triggerWords": { label: "Trigger words" },
    "talk.realtime.provider": { label: "Provider" },
    "talk.realtime.model": { label: "Model" },
    "talk.realtime.speakerVoice": { label: "Speaker voice" },
    "talkPage.talkTranscription": { label: "Talk" },
    "tools.media.audio.preferredModel": { label: "Voice notes" },
  },
});
