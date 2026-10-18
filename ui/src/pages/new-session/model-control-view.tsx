import { createMemo } from "solid-js";
import { ChatModelControls } from "../chat/components/chat-model-controls.tsx";
import type { NewSessionModelControl, NewSessionModelRenderOptions } from "./model-control.ts";

export function NewSessionModelControlView(props: {
  control: NewSessionModelControl;
  options: NewSessionModelRenderOptions;
}) {
  const controls = createMemo(() => props.control.renderProps(props.options));
  return <ChatModelControls {...controls()} />;
}
