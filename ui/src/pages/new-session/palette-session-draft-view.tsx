import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-content.tsx";

export function PaletteSessionAttachments(props: { preview: unknown }) {
  return (
    <div class="cmd-palette__attachments">
      <LitContent value={props.preview} />
    </div>
  );
}

export function PaletteSessionRecovery(props: { onOpen: () => void }) {
  return (
    <button class="btn btn--sm" type="button" onClick={() => props.onOpen()}>
      {t("sessionsView.openSession")}
    </button>
  );
}
