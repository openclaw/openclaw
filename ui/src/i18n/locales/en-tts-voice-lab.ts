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
    namePlaceholder: "Type a name",
    nameEmptyHint: "Required. This field starts empty — nothing is pre-filled.",
    consentTitle: "Consent take",
    consentHint: "Read this sentence out loud, in your own voice:",
    consentStatement:
      "I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.",
    sourceTitle: "Reference take",
    sourceHint:
      "Read this out loud. Same mic and room as the consent take. Ten to thirty seconds is enough.",
    sourceScript:
      "Skip the lighthouse keeper and the silver fog. This is OpenClaw. I am at a desk, talking to a gateway on this machine, and lending it my voice so it can say the next thing without me. A session is waiting, a node is paired, and Control UI looks like it already knows the punchline. I am telling a computer it can sound like a person, which is a weird thing to say out loud.",
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
    needName: "Type a voice name. The field starts empty and is not pre-filled.",
    googleBusy:
      "Google's voice-clone API is unavailable. Your recordings were sent. Prompted voices still work — describe a voice instead, or retry clone later.",
    googleInternal:
      "Google's voice-clone API failed after receiving the clips. This is not a 24 kHz recording problem. Prompted voices still work — describe a voice instead, or retry clone later.",
    needConsent: "Record the consent sentence before storing.",
    needSource: "Record a 10–30 second reference take before storing.",
    sourceTooLong: "The reference take must be 30 seconds or less.",
    advancedSettings: "Custom voices",
  },
} satisfies TranslationMap;

export const registerTtsVoiceLabEnglish = Object.assign(
  () => {
    en.ttsVoiceLab = enTtsVoiceLab.ttsVoiceLab;
  },
  { catalog: enTtsVoiceLab },
);
