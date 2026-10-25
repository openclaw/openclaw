import { createMemo } from "solid-js";
import type { DirectDictationControl } from "../composer-direct-dictation.ts";
import {
  ComposerDictationSendAction,
  renderComposerVoiceButtonSolid as ComposerVoiceButton,
  renderMicrophonePickerSolid as MicrophonePicker,
} from "./chat-composer-controls.tsx";

export function DirectDictationView(props: {
  control: DirectDictationControl;
  ownerKey: string;
  inputDeviceId?: string;
  idleLabel?: string;
  renderRevision?: object;
}) {
  const presentation = createMemo(() => {
    void props.renderRevision;
    return props.control.prepare(props.ownerKey, props.inputDeviceId);
  });
  const microphonePicker = <MicrophonePicker {...presentation().voice.microphonePicker} />;
  return (
    <>
      <ComposerVoiceButton
        {...presentation().voice}
        idleLabel={props.idleLabel}
        microphonePicker={microphonePicker}
      />
      <ComposerDictationSendAction
        readDictation={() => presentation().voice.readDictation()}
        onSend={presentation().onSubmit}
      />
    </>
  );
}
