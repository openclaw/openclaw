import type {
  MessagePresentationAction,
  MessagePresentationButton,
} from "../interactive/payload.js";
import type { ExecApprovalDecision } from "./exec-approvals-core.js";

export type ExecApprovalActionDescriptor = {
  decision: ExecApprovalDecision;
  label: string;
  style: NonNullable<MessagePresentationButton["style"]>;
  /** Optional semantic action; omitted by the shipped command-backed builders. */
  action?: MessagePresentationAction;
  /** Copyable text fallback retained for non-interactive approval surfaces. */
  command: string;
};
