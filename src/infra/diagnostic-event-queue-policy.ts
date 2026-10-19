// Trusted lifecycle terminals displace best-effort diagnostics so recorders can settle active spans.
const ASYNC_EVENT = { priority: false, publicExcluded: false };
const DIAGNOSTIC_EVENT_POLICIES = [
  { ...ASYNC_EVENT, name: "worker.request" },
  { ...ASYNC_EVENT, name: "diagnostic.gc", publicExcluded: true },
  { ...ASYNC_EVENT, name: "gateway.event_loop.sample", publicExcluded: true },
  { ...ASYNC_EVENT, name: "gateway.main_thread.stall", publicExcluded: true },
  { ...ASYNC_EVENT, name: "gateway.http.cancelled", publicExcluded: true },
  { ...ASYNC_EVENT, name: "gateway.rpc", publicExcluded: true },
  { ...ASYNC_EVENT, name: "sessions.list.baseline.retired" },
  { ...ASYNC_EVENT, name: "sessions.list.retention", publicExcluded: true },
  { ...ASYNC_EVENT, name: "sessions.event.retention", publicExcluded: true },
  { ...ASYNC_EVENT, name: "sessions.event.rows.reset", publicExcluded: true },
  { ...ASYNC_EVENT, name: "gateway.ws.event", publicExcluded: true },
  { ...ASYNC_EVENT, name: "gateway.ws.connections", publicExcluded: true },
  { ...ASYNC_EVENT, name: "tool.execution.started" },
  { ...ASYNC_EVENT, name: "tool.execution.completed", priority: true },
  { ...ASYNC_EVENT, name: "tool.execution.error", priority: true },
  { ...ASYNC_EVENT, name: "tool.execution.blocked", priority: true },
  { ...ASYNC_EVENT, name: "skill.used" },
  { ...ASYNC_EVENT, name: "exec.process.completed" },
  { ...ASYNC_EVENT, name: "exec.approval.followup_suppressed" },
  { ...ASYNC_EVENT, name: "message.delivery.started" },
  { ...ASYNC_EVENT, name: "message.delivery.completed" },
  { ...ASYNC_EVENT, name: "message.delivery.error" },
  { ...ASYNC_EVENT, name: "talk.event" },
  { ...ASYNC_EVENT, name: "model.call.started" },
  { ...ASYNC_EVENT, name: "model.call.completed", priority: true },
  { ...ASYNC_EVENT, name: "model.call.error", priority: true },
  { ...ASYNC_EVENT, name: "model.response.observed" },
  { ...ASYNC_EVENT, name: "run.progress" },
  { ...ASYNC_EVENT, name: "run.execution_phase" },
  { ...ASYNC_EVENT, name: "agent.commentary" },
  { ...ASYNC_EVENT, name: "harness.run.completed", priority: true },
  { ...ASYNC_EVENT, name: "harness.run.error", priority: true },
  { ...ASYNC_EVENT, name: "context.assembled" },
  { ...ASYNC_EVENT, name: "log.record", publicExcluded: true },
] as const;

export const ASYNC_DIAGNOSTIC_EVENT_NAMES = DIAGNOSTIC_EVENT_POLICIES.map((policy) => policy.name);
export const PRIORITY_ASYNC_DIAGNOSTIC_EVENT_NAMES = DIAGNOSTIC_EVENT_POLICIES.filter(
  (policy) => policy.priority,
).map((policy) => policy.name);
export const PUBLIC_EXCLUDED_DIAGNOSTIC_EVENT_NAMES = DIAGNOSTIC_EVENT_POLICIES.filter(
  (policy) => policy.publicExcluded,
).map((policy) => policy.name);
