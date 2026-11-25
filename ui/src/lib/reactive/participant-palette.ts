import { controlUiParticipantPalette } from "../../app/control-ui-presentation.ts";
import { createSharedOwnerProjection } from "./shared-owner-projection.ts";

// All transcript leaves share the presentation owner's single palette publication.
const projectPalette = createSharedOwnerProjection(
  (source: typeof controlUiParticipantPalette) => source.current,
);

export const participantPalette = projectPalette(controlUiParticipantPalette);
