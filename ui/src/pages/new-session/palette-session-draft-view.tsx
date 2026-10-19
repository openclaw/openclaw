import { createMemo, Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { AttachmentPreview } from "../chat/components/chat-attachments.tsx";
import { ConnectMachineDialog } from "./connect-machine-dialog-view.tsx";
import type { PaletteSessionDraft } from "./palette-session-draft.ts";
import { PaletteSessionSettingsView } from "./palette-session-settings-view.tsx";

type DraftProps = { draft: PaletteSessionDraft; revision: object };

export function PaletteSessionControls(props: DraftProps) {
  const view = createMemo(() => {
    void props.revision;
    return props.draft.settingsView();
  });
  return <Show when={view()}>{(settings) => <PaletteSessionSettingsView {...settings()} />}</Show>;
}

export function PaletteSessionAttachments(props: DraftProps) {
  const preview = createMemo(() => {
    void props.revision;
    const attachments = props.draft.attachmentProps();
    if (!attachments) {
      return undefined;
    }
    const current = attachments.attachments ?? [];
    return (attachments.attachmentReads?.project(current).length ?? current.length)
      ? attachments
      : undefined;
  });
  return (
    <Show when={preview()}>
      <div class="cmd-palette__attachments">
        <AttachmentPreview {...preview()!} readRevision={props.revision} />
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
