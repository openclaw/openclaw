import type { QuestionDraft, QuestionPrompt } from "../../../app/question-prompt.ts";

export type QuestionPanelQuestion = QuestionPrompt["questions"][number];

export type QuestionPanelViewModel = {
  requestKey: string;
  title: string;
  questions: QuestionPanelQuestion[];
  agentId?: string;
  sessionKey?: string;
  secretStoreAllowedHostsDraft?: string;
  collapsed: boolean;
  autoFocus?: boolean;
  nonBlocking?: boolean;
  collapsedLabel?: string;
  disabled: boolean;
  submitting?: boolean;
  drafts: Map<string, QuestionDraft>;
  error?: string | null;
  notice?: string;
  requestPosition?: { current: number; total: number };
};

export type QuestionPanelProps = {
  model: QuestionPanelViewModel;
  onSubmit?: (answersById: Record<string, string[]>) => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  onChange?: () => void;
  onSecretStoreAllowedHostsChange?: (allowedHosts: string) => void;
  onDismissError?: () => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  onPreviousRequest?: () => void;
  onNextRequest?: () => void;
};

export type QuestionPanelOptions = Pick<
  QuestionPanelProps,
  "onChange" | "onSubmit" | "onSkip" | "onCollapsedChange" | "onPreviousRequest" | "onNextRequest"
> & {
  collapsed?: boolean;
  requestPosition?: QuestionPanelViewModel["requestPosition"];
};
