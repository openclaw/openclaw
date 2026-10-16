import { createMemo } from "solid-js";
import {
  ComposerDictationSendAction,
  renderComposerVoiceButtonSolid as ComposerVoiceButton,
  renderMicrophonePickerSolid as MicrophonePicker,
} from "../chat/components/chat-composer-controls.tsx";
import type { NewSessionDictationControl } from "./composer-dictation-control.ts";

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
  const microphonePicker = <MicrophonePicker {...presentation().voice.microphonePicker} />;
  return (
    <>
      <ComposerVoiceButton {...presentation().voice} microphonePicker={microphonePicker} />
      <ComposerDictationSendAction
        readDictation={() => presentation().voice.readDictation()}
        onSend={presentation().onSubmit}
      />
    </>
  );
}
