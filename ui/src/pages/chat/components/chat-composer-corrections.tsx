import { lazy, Loading, Show } from "solid-js";
import type { createComposerCorrectionBindings } from "./chat-composer-correction-bindings.ts";
import { ComposerCorrectionControls } from "./composer-correction-controls.tsx";

const ComposerCorrectionPresentation = lazy(() => import("../composer-dictation-capture.ts"), {
  export: "ComposerCorrectionPresentation",
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
          <Loading>
            <ComposerCorrectionPresentation
              review={review()}
              resolve={props.context.resolveCorrection}
            />
          </Loading>
        )}
      </Show>
    </>
  );
}
