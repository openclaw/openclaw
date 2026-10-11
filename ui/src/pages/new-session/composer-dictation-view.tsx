import { createMemo } from "solid-js";
import { LitContent } from "../../lit/solid-content.tsx";
import {
  renderComposerDictationSendAction,
  renderComposerDictationStatus,
  renderComposerVoiceButton,
  renderMicrophonePicker,
} from "../chat/components/chat-composer-controls.ts";
import type { NewSessionDictationControl } from "./composer-dictation-control.ts";

export function NewSessionDictationActions(props: {
  presentation: ReturnType<NewSessionDictationControl["prepare"]>;
}) {
  return (
    <>
      <LitContent
        value={renderComposerVoiceButton({
          ...props.presentation.voice,
          microphonePicker: renderMicrophonePicker(props.presentation.voice.microphonePicker),
        })}
      />
      <LitContent
        value={renderComposerDictationSendAction(
          props.presentation.voice.dictation,
          props.presentation.onSubmit,
        )}
      />
    </>
  );
}

export function NewSessionDictationView(props: {
  control: NewSessionDictationControl;
  ownerKey: string;
  inputDeviceId?: string;
  renderRevision?: object;
}) {
  const presentation = createMemo(() => {
    void props.renderRevision;
    return props.control.prepare(props.ownerKey, props.inputDeviceId);
  });
  return <NewSessionDictationActions presentation={presentation()} />;
}

export function NewSessionDictationStatus(props: {
  control: NewSessionDictationControl;
  renderRevision?: object;
}) {
  const status = createMemo(() => {
    void props.renderRevision;
    return renderComposerDictationStatus(props.control.controller);
  });
  return <LitContent value={status()} />;
}
