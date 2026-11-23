import { createMemo, lazy } from "solid-js";
import { listen } from "../../lib/reactive/listener.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { ChatLazyBoundary } from "./components/chat-lazy-boundary.tsx";
import type {
  ComposerMicrophoneOwner,
  VoiceApiKeyProviders,
} from "./composer-microphone-picker.ts";
import type { VoiceApiKeyNoticeProps } from "./voice-api-key-notice.tsx";

// Transcript rows render in the virtualizer's own roots, outside any pane context, so the
// composer publishes its catalog owner here. With several composers, the last synced one wins.
const published = new (class extends EventTarget {
  picker?: ComposerMicrophoneOwner;
  configure?: (provider: string) => void;
  subscribe(notify: () => void) {
    return listen(this, "change", notify);
  }
})();

export function publishVoiceApiKeys(
  picker: ComposerMicrophoneOwner,
  configure: ((provider: string) => void) | undefined,
) {
  published.configure = configure;
  if (published.picker !== picker) {
    published.picker = picker;
    published.dispatchEvent(new Event("change"));
  }
}

export function useVoiceApiKey() {
  const source = projectOwner(published, (owner) => owner.picker);
  const keys = createMemo(() => {
    const picker = source.read();
    return picker && projectOwner(picker, (owner) => owner.apiKeyProviders);
  });
  return {
    provider: (surface: keyof VoiceApiKeyProviders) => keys()?.read()[surface],
    configure: (provider: string) => published.configure?.(provider),
  };
}

// The notice and its copy load only when one is shown.
const LazyVoiceApiKeyNotice = lazy(() => import("./voice-api-key-notice.tsx"), {
  export: "VoiceApiKeyNotice",
});

export function VoiceApiKeyNotice(props: VoiceApiKeyNoticeProps) {
  return (
    <ChatLazyBoundary>
      <LazyVoiceApiKeyNotice {...props} />
    </ChatLazyBoundary>
  );
}
