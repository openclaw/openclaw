export type BrowserVoiceOption = {
  uri: string;
  name: string;
  lang: string;
  isDefault: boolean;
};

export type SpeakBrowserVoiceParams = {
  text: string;
  voiceUri?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
};

function getSpeechSynthesis(): SpeechSynthesis | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.speechSynthesis ?? null;
}

export function isBrowserVoiceSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof SpeechSynthesisUtterance !== "undefined" &&
    Boolean(getSpeechSynthesis())
  );
}

export function listBrowserVoiceOptions(): BrowserVoiceOption[] {
  const synth = getSpeechSynthesis();
  if (!synth) {
    return [];
  }
  const voices = synth.getVoices();
  if (!voices.length) {
    return [];
  }

  const byUri = new Map<string, BrowserVoiceOption>();
  for (const voice of voices) {
    const uri = voice.voiceURI?.trim();
    if (!uri || byUri.has(uri)) {
      continue;
    }
    byUri.set(uri, {
      uri,
      name: voice.name?.trim() || uri,
      lang: voice.lang?.trim() || "und",
      isDefault: Boolean(voice.default),
    });
  }

  return [...byUri.values()].toSorted((a, b) => {
    if (a.isDefault !== b.isDefault) {
      return a.isDefault ? -1 : 1;
    }
    if (a.lang !== b.lang) {
      return a.lang.localeCompare(b.lang);
    }
    return a.name.localeCompare(b.name);
  });
}

function resolveVoice(voiceUri?: string): SpeechSynthesisVoice | null {
  const wanted = voiceUri?.trim();
  if (!wanted) {
    return null;
  }
  const synth = getSpeechSynthesis();
  if (!synth) {
    return null;
  }
  const voice = synth.getVoices().find((entry) => entry.voiceURI === wanted);
  return voice ?? null;
}

export function cancelBrowserVoicePlayback() {
  const synth = getSpeechSynthesis();
  if (!synth) {
    return;
  }
  synth.cancel();
}

export function speakBrowserVoice(params: SpeakBrowserVoiceParams): boolean {
  const synth = getSpeechSynthesis();
  if (!synth) {
    return false;
  }
  const text = params.text.trim();
  if (!text) {
    return false;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const selectedVoice = resolveVoice(params.voiceUri);
  if (selectedVoice) {
    utterance.voice = selectedVoice;
  }
  utterance.rate = Number.isFinite(params.rate) ? Math.min(2, Math.max(0.5, params.rate!)) : 1;
  utterance.pitch = Number.isFinite(params.pitch) ? Math.min(2, Math.max(0, params.pitch!)) : 1;
  utterance.volume = Number.isFinite(params.volume) ? Math.min(1, Math.max(0, params.volume!)) : 1;

  synth.cancel();
  synth.speak(utterance);
  return true;
}
