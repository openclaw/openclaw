import { lazy, Show } from "solid-js";
import type { createComposerCorrectionBindings } from "./chat-composer-correction-bindings.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { ComposerCorrectionControls } from "./composer-correction-controls.tsx";
import { ComposerCorrectionRecovery } from "./composer-correction-recovery.tsx";

// Policy controls stay available without loading the recording review surface.
const ComposerCorrectionReview = lazy(() => import("./composer-correction-review.tsx"), {
  export: "ComposerCorrectionReview",
});

export function ChatComposerCorrections(props: {
  context: ReturnType<typeof createComposerCorrectionBindings>;
  showControls: boolean;
}) {
  return (
    <>
      <Show when={props.showControls}>
        <ComposerCorrectionControls {...props.context.correctionControls} />
      </Show>
      <Show when={props.context.correctionReview}>
        {(review) => (
          <ChatLazyBoundary
            recovery={
              <ComposerCorrectionRecovery
                original={review().original}
                canKeepOriginal={review().canKeepOriginal}
                onKeepOriginal={() => props.context.resolveCorrection("original")}
                onCancel={() => props.context.resolveCorrection("cancel")}
              />
            }
          >
            <ComposerCorrectionReview
              original={review().original}
              reason={review().invalidated ? "source-changed" : "corrections-unavailable"}
              canKeepOriginal={review().canKeepOriginal}
              onKeepOriginal={() => props.context.resolveCorrection("original")}
              onCancel={() => props.context.resolveCorrection("cancel")}
            />
          </ChatLazyBoundary>
        )}
      </Show>
    </>
  );
}
