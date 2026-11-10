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
  /** Display name of the child session that asked, when it is not this conversation. */
  requestedBySession?: string;
  requestedBySessionHref?: string;
  requestPosition?: { current: number; total: number };
};

export type QuestionPanelProps = {
  getTranscriptElement?: () => HTMLElement | null;
  model: QuestionPanelViewModel;
  onSubmit?: (answersById: Record<string, string[]>) => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  onChange?: () => void;
  onOpenSession?: () => void;
  onSecretStoreAllowedHostsChange?: (allowedHosts: string) => void;
  onDismissError?: () => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  onPreviousRequest?: () => void;
  onNextRequest?: () => void;
};

export type QuestionPanelOptions = Pick<
  QuestionPanelProps,
  | "onChange"
  | "onSubmit"
  | "onSkip"
  | "onCollapsedChange"
  | "onPreviousRequest"
  | "onNextRequest"
  | "onOpenSession"
> & {
  collapsed?: boolean;
  requestedBySession?: string;
  requestedBySessionHref?: string;
  requestPosition?: QuestionPanelViewModel["requestPosition"];
};
