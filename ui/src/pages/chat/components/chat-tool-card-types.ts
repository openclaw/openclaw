import type { JSX } from "@solidjs/web";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { ToolRenderOptions } from "./chat-tool-render-model.ts";

export type ToolCardOptions = ToolRenderOptions & {
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
  showApprovalReviews?: boolean;
  activityCards?: readonly ToolCard[];
};
export type ToolCardProps = {
  card: ToolCard;
  options: ToolCardOptions;
  hasChildren?: boolean;
  children?: JSX.Element;
};
