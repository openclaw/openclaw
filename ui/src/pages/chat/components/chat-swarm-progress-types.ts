import type { GatewaySessionRow } from "../../../api/types.ts";

export type ChatSwarmProgressProps = {
  sessions: readonly GatewaySessionRow[];
  sessionKey: string;
  agentId?: string;
};
