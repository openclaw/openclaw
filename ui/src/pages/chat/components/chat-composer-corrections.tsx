import { lazy, Loading, Show } from "solid-js";
import type { createComposerCorrectionBindings } from "./chat-composer-correction-bindings.ts";

const ComposerCorrectionPresentation = lazy(() => import("../composer-dictation-capture.ts"), {
  export: "ComposerCorrectionPresentation",
});

export function ChatComposerCorrections(props: {
  context: Pick<
    ReturnType<typeof createComposerCorrectionBindings>,
    "correctionReview" | "resolveCorrection"
  >;
}) {
  return (
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
  );
}
