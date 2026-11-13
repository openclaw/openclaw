import type { JSX } from "@solidjs/web";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { ToolCardOutput } from "../../../lib/chat/tool-cards.ts";
import type { ToolRenderOptions } from "./chat-tool-render-model.ts";

export type ToolCardOptions = ToolRenderOptions & {
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
  showApprovalReviews?: boolean;
  activityCards?: readonly ToolCard[];
  executionCards?: readonly ToolCard[];
};
export type ToolCardProps = {
  card: ToolCard;
  options: ToolCardOptions;
  hasChildren?: boolean;
  children?: JSX.Element;
};

export type ToolCardContentProps = {
  card: ToolCard;
  /** The adjacent disclosure already presents this command's compact form. */
  commandInRow?: boolean;
  output?: ToolCardOutput;
  options: ToolRenderOptions;
};
