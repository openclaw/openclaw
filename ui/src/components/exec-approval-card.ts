import { html } from "lit";
import type { ExecApprovalCardProps } from "./exec-approval-card-solid.tsx";
import "./exec-approval-card-solid.tsx";

/** Stateless adapters for the remaining Lit consumers; Solid owns the card contents. */
export function renderExecApprovalCard(props: ExecApprovalCardProps) {
  return html`<openclaw-exec-approval-card .props=${props}></openclaw-exec-approval-card>`;
}
