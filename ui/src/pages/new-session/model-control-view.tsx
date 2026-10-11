import { createMemo } from "solid-js";
import { LitContent } from "../../lit/solid-content.tsx";
import { renderChatModelControls } from "../chat/components/chat-model-controls.ts";
import type { NewSessionModelControl, NewSessionModelRenderOptions } from "./model-control.ts";

export function NewSessionModelControlView(props: {
  control: NewSessionModelControl;
  options: NewSessionModelRenderOptions;
}) {
  const controls = createMemo(() => props.control.renderProps(props.options));
  return <LitContent value={renderChatModelControls(controls())} />;
}
