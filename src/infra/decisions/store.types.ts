/**
 * Decision system types for agent command and control.
 * Decisions allow agents to request user input via Slack or other channels.
 */

export type DecisionType = "binary" | "choice" | "text" | "confirmation";

export type DecisionStatus = "pending" | "responded" | "expired";

export type DecisionOption = {
  /** Unique option identifier. */
  id: string;
  /** Display label for this option. */
  label: string;
  /** Value returned when selected. */
  value: string;
  /** Optional button style (e.g., "primary", "danger"). */
  style?: "primary" | "danger";
};

export type DecisionContext = {
  /** Session key of the requesting agent. */
  sessionKey?: string;
  /** Agent ID making the request. */
  agentId?: string;
  /** Associated goal ID. */
  goalId?: string;
  /** Associated assignment ID. */
  assignmentId?: string;
};

export type DecisionResponder = {
  /** User ID who responded (e.g., Slack user ID). */
  userId: string;
  /** User name who responded. */
  userName?: string;
};

export type DecisionResponse = {
  /** Selected option ID (for binary/choice/confirmation). */
  optionId?: string;
  /** Selected option value (for binary/choice/confirmation). */
  optionValue?: string;
  /** Free-form text response (for text type). */
  textValue?: string;
};

export type DecisionRecord = {
  /** Unique decision identifier. */
  decisionId: string;
  /** Type of decision (binary, choice, text, confirmation). */
  type: DecisionType;
  /** Current status of the decision. */
  status: DecisionStatus;
  /** Decision title displayed to user. */
  title: string;
  /** Question/prompt for the user. */
  question: string;
  /** Available options (for binary/choice/confirmation). */
  options?: DecisionOption[];
  /** Context about the requesting agent/session. */
  context: DecisionContext;
  /** Slack channel where the decision was posted. */
  slackChannel?: string;
  /** Slack message timestamp (for updating the message). */
  slackMessageTs?: string;
  /** Who responded to the decision. */
  respondedBy?: DecisionResponder;
  /** When the decision was responded to. */
  respondedAt?: number;
  /** The response data. */
  response?: DecisionResponse;
  /** When the decision was created. */
  createdAt: number;
  /** When the decision expires. */
  expiresAt?: number;
};

export type DecisionStore = {
  version: 1;
  decisions: Record<string, DecisionRecord>;
  updatedAt?: number;
};

export type CreateDecisionParams = {
  type: DecisionType;
  title: string;
  question: string;
  options?: Array<{ label: string; value?: string; style?: "primary" | "danger" }>;
  context?: DecisionContext;
  timeoutMinutes?: number;
};

export type RespondDecisionParams = {
  decisionId: string;
  optionId?: string;
  optionValue?: string;
  textValue?: string;
  respondedBy: DecisionResponder;
};
