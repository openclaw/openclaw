import { solidContent } from "../../../lit/solid-content.tsx";
import {
  StreamGroup,
  WorkGroupSummary,
  renderSolidStreamGroup,
  renderSolidWorkGroupSummary,
} from "./chat-message-stream-view.tsx";

export * from "./chat-message-stream-view.tsx";

export function renderStreamGroup(...args: Parameters<typeof renderSolidStreamGroup>) {
  return solidContent(StreamGroup, { parts: args[0], options: args[1] ?? {} });
}

export function renderWorkGroupSummary(...args: Parameters<typeof renderSolidWorkGroupSummary>) {
  return solidContent(WorkGroupSummary, { item: args[0], options: args[1] });
}
