import type { Static } from "typebox";
import type { AgentParamsSchema } from "../../../packages/gateway-protocol/src/schema/agent.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { ChatAttachment } from "../chat-attachments.js";

export type AgentRpcRunRequest = Omit<
  Static<typeof AgentParamsSchema>,
  "attachments" | "internalEvents" | "inputProvenance"
> & {
  attachments?: Array<Pick<ChatAttachment, "type" | "mimeType" | "fileName" | "content">>;
  internalEvents?: AgentInternalEvent[];
  inputProvenance?: InputProvenance;
  workspaceDir?: string;
};

/** Runtime requests contain only canonical execution kinds after protocol adaptation. */
export type AgentRunRequest = Omit<AgentRpcRunRequest, "bootstrapContextRunKind"> & {
  bootstrapContextRunKind?: "default" | "cron";
};
