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
                original={review().result.original}
                canKeepOriginal={review().canKeepOriginal}
                onKeepOriginal={() => props.context.resolveCorrection("original")}
                onCancel={() => props.context.resolveCorrection("cancel")}
              />
            }
          >
            <ComposerCorrectionReview
              original={review().result.original}
              candidate={review().result.plan ? review().result.candidate : null}
              correctionCount={
                new Set(
                  review().result.plan?.edits.map(
                    (edit) => `${edit.triggerRange.start}:${edit.triggerRange.end}`,
                  ),
                ).size
              }
              changes={
                review().result.plan?.edits.map((edit) => ({
                  id: edit.id,
                  original: review().result.original.slice(edit.range.start, edit.range.end),
                  replacement: edit.replacement,
                })) ?? []
              }
              reason={review().invalidated ? "source-changed" : review().result.reasons[0]}
              canAccept={review().canAccept}
              canKeepOriginal={review().canKeepOriginal}
              onKeepOriginal={() => props.context.resolveCorrection("original")}
              onAcceptCorrection={() => props.context.resolveCorrection("correction")}
              onCancel={() => props.context.resolveCorrection("cancel")}
            />
          </ChatLazyBoundary>
        )}
      </Show>
    </>
  );
}
