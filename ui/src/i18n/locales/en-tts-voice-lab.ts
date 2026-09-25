import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enTtsVoiceLab = {
  ttsVoiceLab: {
    title: "Custom voices",
    intro:
      "Record both takes here. This is not tap-to-talk: that path turns speech into text and drops the audio.",
    create: "Create from my voice",
    close: "Close",
    name: "Voice name",
    namePlaceholder: "Bobby",
    consentTitle: "Consent take",
    consentHint: "Read this sentence out loud, in your own voice:",
    consentStatement:
      "I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.",
    sourceTitle: "Reference take",
    sourceHint: "Talk naturally for 10–30 seconds on the same microphone, same room.",
    record: "Start recording",
    stop: "Stop recording",
    rerecord: "Record again",
    recorded: "Recorded {seconds}s",
    recording: "Recording {seconds}s",
    pending: "Waiting for microphone…",
    level: "Microphone level",
    inPageRecorder:
      "Capture stays in this dialog. macOS may ask for microphone access. There is no separate recorder app.",
    createVoice: "Store voice",
    creating: "Storing on Google…",
    stored: "Stored {name}",
    preview: "Preview",
    empty: "No stored custom voices on this Google project yet.",
    unavailable: "This Gateway does not advertise voice replication yet.",
    disconnected: "Connect to the Gateway to create a custom voice.",
    listError: "Could not list stored voices.",
    createError: "Could not store that voice.",
    talkHint: "Stored voices work for TTS playback. Talk and Live still use prebuilt names.",
    durationHint:
      "Consent needs a full reading of the sentence. The reference take must be 10–30 seconds.",
    advancedSettings: "Custom voices",
  },
} satisfies TranslationMap;

export const registerTtsVoiceLabEnglish = Object.assign(
  () => {
    en.ttsVoiceLab = enTtsVoiceLab.ttsVoiceLab;
  },
  { catalog: enTtsVoiceLab },
);
