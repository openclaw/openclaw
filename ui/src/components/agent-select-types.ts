import type { GatewayAgentRow } from "../api/types.ts";
import type { LegacyTemplateResult } from "../lit/solid-content.tsx";

export type AgentSelectOption = {
  value: string;
  label: string;
  agent?: GatewayAgentRow;
  icon?: LegacyTemplateResult;
  description?: string;
  badge?: string;
  disabled?: boolean;
};
