import type { PluginHookName } from "./hook-types.js";

type PluginHookMetadata = {
  conversationAccess?: boolean;
  promptInjection?: boolean;
  voidTimeoutMs?: number;
  modifyingTimeoutMs?: number;
};

export const PLUGIN_HOOK_METADATA: Readonly<Record<PluginHookName, PluginHookMetadata>> = {
  before_model_resolve: { conversationAccess: true },
  agent_turn_prepare: { conversationAccess: true, promptInjection: true },
  before_prompt_build: {
    conversationAccess: true,
    promptInjection: true,
    modifyingTimeoutMs: 15_000,
  },
  before_agent_reply: { conversationAccess: true },
  model_call_started: {},
  model_call_ended: {},
  llm_input: { conversationAccess: true },
  llm_output: { conversationAccess: true },
  // Terminal finalization hooks sit on the runner's completion path. A hung
  // handler must not freeze final delivery or keep compaction retry recovery
  // unresolved; timeout fail-opens with the original final answer.
  before_agent_finalize: { conversationAccess: true, modifyingTimeoutMs: 15_000 },
  agent_end: { conversationAccess: true, voidTimeoutMs: 30_000 },
  // Compaction hooks run on the serialized notification queue. Allow memory
  // flushes the agent_end budget, then fail open so later notifications proceed.
  before_compaction: { voidTimeoutMs: 30_000 },
  after_compaction: { voidTimeoutMs: 30_000 },
  before_reset: {},
  before_channel_ingress: { conversationAccess: true, modifyingTimeoutMs: 15_000 },
  inbound_claim: {},
  channel_pairing_requested: { voidTimeoutMs: 2_000 },
  message_received: {},
  // Outbound modifying hooks run inside the serialized reply delivery lane.
  // A hung plugin must fail open so later hooks and queued replies can settle.
  message_sending: { modifyingTimeoutMs: 15_000 },
  reply_payload_sending: { modifyingTimeoutMs: 15_000 },
  message_sent: {},
  // Policy hooks fail closed in the global runner. A bounded timeout turns a
  // stalled policy process into a denial instead of freezing the operation.
  before_tool_call: { modifyingTimeoutMs: 15_000 },
  after_tool_call: {},
  tool_result_persist: {},
  before_message_write: {},
  session_start: {},
  session_end: {},
  run_stopped: {},
  run_failed: { conversationAccess: true, voidTimeoutMs: 30_000 },
  subagent_delivery_target: {},
  subagent_spawned: {},
  subagent_progress: {},
  subagent_ended: {},
  gateway_start: {},
  // Shutdown hooks share the Gateway's five-second teardown budget. They fail
  // open after logging so one plugin cannot consume the process watchdog.
  gateway_stop: { voidTimeoutMs: 5_000 },
  heartbeat_prompt_contribution: { promptInjection: true },
  cron_reconciled: {},
  cron_changed: {},
  skill_changed: { voidTimeoutMs: 30_000 },
  before_dispatch: {},
  reply_dispatch: {},
  before_install: { modifyingTimeoutMs: 15_000 },
  before_agent_run: { conversationAccess: true, modifyingTimeoutMs: 15_000 },
  resolve_exec_env: { modifyingTimeoutMs: 15_000 },
};
