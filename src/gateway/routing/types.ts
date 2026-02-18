export enum ModelTier {
  TIER1 = "tier1",
  TIER2 = "tier2",
  TIER3 = "tier3",
}

export enum TaskType {
  CODE_EDIT = "code_edit",
  CODE_REVIEW = "code_review",
  CODE_REFACTOR = "code_refactor",
  CODE_DEBUG = "code_debug",
  DOC_WRITE = "doc_write",
  DOC_REVIEW = "doc_review",
  VISUAL_CRITIQUE = "visual_critique",
  VISUAL_GENERATE = "visual_generate",
  HEARTBEAT_CHECK = "heartbeat_check",
  SECURITY_AUDIT = "security_audit",
  SHELL_SCRIPT = "shell_script",
  GIT_OPS = "git_ops",
  TEST_WRITE = "test_write",
  TEST_RUN = "test_run",
  QUERY_READ = "query_read",
  QUERY_WRITE = "query_write",
  TRANSLATION = "translation",
  SCAFFOLD = "scaffold",
  CI_DEBUG = "ci_debug",
  MEMORY_UPDATE = "memory_update",
  PLANNING = "planning",
  REASONING = "reasoning",
  MULTIMODAL_ANALYSIS = "multimodal_analysis",
  FALLBACK = "fallback",
}

export type HealthConfig = {
  enabled: boolean;
  window_size: number; // default 20
  threshold: number; // default 0.5
  cooldown_ms: number; // default 60000
  persist_path?: string;
};

export type ReviewGateConfig = {
  enabled: boolean;
  mode: "auto" | "manual"; // auto=自动触发, manual=需用户确认
  high_risk_types: TaskType[]; // 默认: [CODE_REFACTOR, SECURITY_AUDIT, GIT_OPS]
  reviewer_model: string; // 如 "anthropic/claude-opus-4-6"
  reviewer_system_prompt: string; // reviewer 的 system prompt
  timeout_ms: number; // 审核超时，默认 60000
};

export type RoutingConfig = {
  default_task_type: TaskType;
  cooldown_seconds: number;
  antiflap_enabled: boolean;
  triggers: Record<string, TaskType>;
  deny_list: string[];
  ha_matrix: Partial<Record<TaskType, Partial<Record<ModelTier, string>>>>;
  health?: HealthConfig;
  review_gate?: ReviewGateConfig;
};
