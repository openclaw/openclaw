import { createMemo, Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent, emptyLegacyContent } from "../../lit/solid-content.tsx";
import { renderAttachmentPreview } from "../chat/components/chat-attachments.ts";
import { ConnectMachineDialog } from "./connect-machine-dialog-view.tsx";
import type { PaletteSessionDraft } from "./palette-session-draft.ts";
import { PaletteSessionSettingsView } from "./palette-session-settings-view.tsx";

type DraftProps = { draft: PaletteSessionDraft; revision: object };

export function PaletteSessionControls(props: DraftProps) {
  const view = createMemo(() => {
    void props.revision;
    return props.draft.settingsView();
  });
  return (
    <Show when={view()}>{(settings) => <PaletteSessionSettingsView view={settings()} />}</Show>
  );
}

export function PaletteSessionAttachments(props: DraftProps) {
  const preview = createMemo(() => {
    void props.revision;
    const attachments = props.draft.attachmentProps();
    const rendered = attachments ? renderAttachmentPreview(attachments) : emptyLegacyContent;
    return rendered === emptyLegacyContent ? undefined : rendered;
  });
  return (
    <Show when={preview()}>
      <div class="cmd-palette__attachments">
        <LitContent value={preview()} />
      </div>
    </Show>
  );
}

export function PaletteSessionAuxiliary(props: DraftProps) {
  const view = createMemo(() => {
    void props.revision;
    return props.draft.auxiliaryView();
  });
  return <ConnectMachineDialog {...view()} />;
}

export function PaletteSessionRecovery(props: { onOpen: () => void }) {
  return (
    <button class="btn btn--sm" type="button" onClick={() => props.onOpen()}>
      {t("sessionsView.openSession")}
    </button>
  );
}
