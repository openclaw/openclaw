import { ChatModelControls } from "./components/chat-model-controls.tsx";

export function ChatPaneModelControl(props: { model: Parameters<typeof ChatModelControls>[0] }) {
  return (
    <div class="chat-composer-model-control">
      <ChatModelControls {...props.model} />
    </div>
  );
}
