import { solidContent } from "../../../lit/solid-content.tsx";
import { ChatSwarmProgress, type ChatSwarmProgressProps } from "./chat-swarm-progress.solid.tsx";

export function renderChatSwarmProgress(props: ChatSwarmProgressProps) {
  return solidContent(ChatSwarmProgress, props);
}
