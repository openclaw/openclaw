let activeAudio: {
  media: HTMLMediaElement;
  onSuperseded: () => void;
} | null = null;

/** Claims the page's audio slot and pauses any previously playing chat audio. */
export function claimChatAudioPlayback(media: HTMLMediaElement, onSuperseded: () => void): void {
  if (activeAudio?.media === media) {
    activeAudio.onSuperseded = onSuperseded;
    return;
  }
  activeAudio?.onSuperseded();
  activeAudio?.media.pause();
  activeAudio = { media, onSuperseded };
}

export function releaseChatAudioPlayback(media: HTMLMediaElement): void {
  if (activeAudio?.media === media) {
    activeAudio = null;
  }
}

export function canResumeChatAudioPlayback(media: HTMLMediaElement): boolean {
  return activeAudio === null || activeAudio.media === media;
}
