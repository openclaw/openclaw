import { solidContent } from "../../../lit/solid-content.tsx";
import {
  renderSolidEmptyGroupFooter,
  StreamGroup,
  StreamGroupParts,
  StreamPartView,
  UnplacedSubagentWait,
  WorkGroupSummary,
  renderSolidStreamGroupParts,
  renderSolidUnplacedSubagentWait,
  renderSolidStreamGroupPart,
  renderSolidStreamGroup,
  renderSolidWorkGroupSummary,
} from "./chat-message-stream-view.tsx";

export * from "./chat-message-stream-view.tsx";

export function renderStreamGroupParts(...args: Parameters<typeof renderSolidStreamGroupParts>) {
  return solidContent(StreamGroupParts, {
    parts: args[0],
    options: args[1],
    presentation: args[2],
  });
}

export function renderUnplacedSubagentWait(
  ...args: Parameters<typeof renderSolidUnplacedSubagentWait>
) {
  return solidContent(UnplacedSubagentWait, {
    sessionKey: args[0],
    wait: args[1],
    options: args[2],
  });
}

export function renderStreamGroupPart(...args: Parameters<typeof renderSolidStreamGroupPart>) {
  return solidContent(StreamPartView, { part: args[0], options: args[1], presentation: args[2] });
}

export function renderStreamGroup(...args: Parameters<typeof renderSolidStreamGroup>) {
  return solidContent(StreamGroup, { parts: args[0], options: args[1] ?? {} });
}

export function renderWorkGroupSummary(...args: Parameters<typeof renderSolidWorkGroupSummary>) {
  return solidContent(WorkGroupSummary, { item: args[0], options: args[1] });
}

export const emptyGroupFooter = solidContent(renderSolidEmptyGroupFooter, {});
