import { solidContent } from "../../../lit/solid-content.tsx";
import {
  StreamGroup,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message-stream-view.tsx";

export function renderStreamGroup(parts: StreamGroupPart[], options: StreamGroupOptions = {}) {
  return solidContent(StreamGroup, { parts, options });
}
