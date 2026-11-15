import { PRESENTATION_CHANGED_EVENT, type PresentationValue } from "../presentation.ts";
import { listen } from "./listener.ts";
import { projectSource, type SourceProjection } from "./projection.ts";

/** Read through the presentation owner while observing its visibility changes. */
export function projectPresentation(
  source: PresentationValue,
): SourceProjection<PresentationValue, boolean> {
  return projectSource(source, {
    read: (value) => (typeof value === "boolean" ? value : value.isPresented()),
    subscribe: (value, notify) =>
      typeof value === "boolean"
        ? () => {}
        : listen(value.owner, PRESENTATION_CHANGED_EVENT, notify),
    equality: Object.is,
  });
}
