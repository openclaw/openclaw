import type { GatewayAgentRow } from "../api/types.ts";
import type { IconName } from "./icon-data.ts";

export type AgentSelectOption = {
  value: string;
  label: string;
  agent?: GatewayAgentRow;
  icon?: IconName;
  description?: string;
  badge?: string;
  disabled?: boolean;
};
