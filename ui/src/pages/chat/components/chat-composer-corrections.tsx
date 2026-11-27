import { lazy, Loading, Show } from "solid-js";
import type { createComposerCorrectionBindings } from "./chat-composer-correction-bindings.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { ComposerCorrectionControls } from "./composer-correction-controls.tsx";

// Policy controls stay available without loading the recording review surface.
const ComposerCorrectionReview = lazy(() => import("./composer-correction-review.tsx"), {
  export: "ComposerCorrectionReview",
});
const ComposerCorrectionRecovery = lazy(() => import("../composer-dictation-capture.ts"), {
  export: "ComposerCorrectionRecovery",
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
              <Loading>
                <ComposerCorrectionRecovery
                  original={review().original}
                  canKeepOriginal={review().canKeepOriginal}
                  onKeepOriginal={() => props.context.resolveCorrection("original")}
                  onCancel={() => props.context.resolveCorrection("cancel")}
                />
              </Loading>
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
