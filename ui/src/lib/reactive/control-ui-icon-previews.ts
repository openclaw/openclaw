import { controlUiIconPreviews } from "../../app/control-ui-environment-presentation.runtime.ts";
import { createDetachedRoot } from "./detached-root.ts";
import { projectOwner } from "./projection.ts";

export const controlUiIconPreviewsProjection = createDetachedRoot(
  () => projectOwner(controlUiIconPreviews, (owner) => owner.read(), Object.is).read,
);
