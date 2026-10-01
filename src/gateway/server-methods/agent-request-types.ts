import type { Static } from "typebox";
import type { AgentParamsSchema } from "../../../packages/gateway-protocol/src/schema/agent.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";

export type AgentRunRequest = Omit<
  Static<typeof AgentParamsSchema>,
  "attachments" | "internalEvents" | "inputProvenance"
> & {
  attachments?: Array<{
    type?: string;
    mimeType?: string;
    fileName?: string;
    content?: unknown;
  }>;
  internalEvents?: AgentInternalEvent[];
  inputProvenance?: InputProvenance;
  workspaceDir?: string;
};
