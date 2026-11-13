import { createMemo, createSignal, Show } from "solid-js";
import { createChatAttachmentInputHandle } from "../chat/components/chat-attachment-inputs.ts";
import { ChatAttachmentInputs } from "../chat/components/chat-attachment-inputs.tsx";
import { AttachmentPreview } from "../chat/components/chat-attachments.tsx";
import { ChatComposerPlusMenu } from "../chat/components/chat-composer-plus-menu.tsx";
import type { ChatCommentAction } from "../chat/components/chat-selection-annotations.tsx";
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

/** The composer's own add menu, limited to this draft's attachment sources. */
export function PaletteSessionAddMenu(props: DraftProps) {
  const inputHandle = createChatAttachmentInputHandle();
  const [open, setOpen] = createSignal(false);
  const attachments = createMemo(() => {
    void props.revision;
    return props.draft.attachmentProps();
  });
  return (
    <Show when={attachments()}>
      {(current) => (
        <>
          <ChatAttachmentInputs {...current()} inputHandle={inputHandle} />
          <ChatComposerPlusMenu
            menu={{
              attachments: current(),
              inputHandle,
              disabled: props.draft.messageLocked,
              open: open(),
              view: "root",
              toolOverrides: undefined,
              onOpenChange: setOpen,
              onViewChange: () => {},
            }}
          />
        </>
      )}
    </Show>
  );
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
      <div
        class="cmd-palette__attachments"
        onOpenclaw-comment-action={(event: CustomEvent<ChatCommentAction>) =>
          props.draft.removeComment(event.detail)
        }
      >
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
