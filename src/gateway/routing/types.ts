export enum ModelTier {
  TIER1 = "tier1",
  TIER2 = "tier2",
  TIER3 = "tier3",
}

export enum TaskType {
  CODE_EDIT = "code_edit",
  FALLBACK = "fallback",
}

export type RoutingConfig = {
  default_task_type: TaskType;
  cooldown_seconds: number;
  antiflap_enabled: boolean;
  triggers: Record<string, TaskType>;
  deny_list: string[];
  ha_matrix: Partial<Record<TaskType, Partial<Record<ModelTier, string>>>>;
};
