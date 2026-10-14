import { solidContent } from "../../../lit/solid-content.tsx";
import {
  StreamGroup,
  WorkGroupSummary,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message-stream-view.tsx";

export function renderStreamGroup(parts: StreamGroupPart[], options: StreamGroupOptions = {}) {
  return solidContent(StreamGroup, { parts, options });
}

export function renderWorkGroupSummary(
  item: Parameters<typeof WorkGroupSummary>[0]["item"],
  options: Parameters<typeof WorkGroupSummary>[0]["options"],
) {
  return solidContent(WorkGroupSummary, { item, options });
}
