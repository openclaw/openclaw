// Plugin integration tests retain Gateway runtime setup outside core source.
export const gatewayPluginTestFiles = ["test/plugins/codex-model-catalog.gateway.test.ts"];

// Native database consumers retain the Gateway runner and setup in forked processes.
export const gatewayDatabaseWorkerTestFiles = [
  "src/gateway/config-reload.test.ts",
  "src/gateway/gateway-code-mode-clock.test.ts",
  "src/gateway/gateway.chat-redaction.test.ts",
  "src/gateway/health/collector.queue-health.test.ts",
  "src/gateway/local-request-context.test.ts",
  "src/gateway/managed-image-attachments.test.ts",
  "src/gateway/server-methods/chat-send-synthetic-repair.integration.test.ts",
  "src/gateway/server-methods/cron.list-scoped.test.ts",
  "src/gateway/server-methods/cron.runs.test.ts",
  "src/gateway/server-methods/cron.self-removal.test.ts",
  "src/gateway/server-methods/cron.validation.test.ts",
  "src/gateway/server-methods/models-auth-removal.integration.test.ts",
  "src/gateway/server-methods/models-dispatch.catalog.integration.test.ts",
  "src/gateway/server-methods/models-dispatch.lifecycle.integration.test.ts",
  "src/gateway/server-methods/models-list.freshness.integration.test.ts",
  "src/gateway/server-methods/models-list.membership.integration.test.ts",
  "src/gateway/server-methods/models-list.native-lifecycle.integration.test.ts",
  "src/gateway/server-methods/requester-cron-authority.integration.test.ts",
  "src/gateway/server-methods/server-methods.test.ts",
  "src/gateway/server-methods/worktrees.authorization.test.ts",
  "src/gateway/server-methods/worktrees.test.ts",
  "src/gateway/session-delivery-clock-jump.integration.test.ts",
  "src/gateway/setup-inference.first-signin.integration.test.ts",
];

// Canonical file ownership for the non-isolated Gateway server Vitest project.
export const gatewayServerBackedHttpTestFiles = [
  "src/gateway/embeddings-http.test.ts",
  "src/gateway/models-http.test.ts",
  "src/gateway/openai-http.test.ts",
  "src/gateway/openresponses-http.test.ts",
  "src/gateway/probe.auth.integration.test.ts",
  "src/gateway/sessions-history-http.test.ts",
];

// Gateway methods needing native process state or a private module graph keep
// the shared methods runner in isolated forks.
export const gatewayMethodsIsolatedTestFiles = [
  "src/gateway/server-methods/agent.test.ts",
  "src/gateway/server-methods/board.runtime-boundaries.test.ts",
  "src/gateway/server-methods/chat.reset-visible-yield.test.ts",
  // Status uses the host-owned shared SQLite broker.
  "src/gateway/server-methods/health.owner-routing.test.ts",
  "src/gateway/server-methods/system-agent-nested-inference.integration.test.ts",
  "src/gateway/server-methods/system-agent-setup-control-ui.test.ts",
  "src/gateway/server-methods/users-preferences.test.ts",
  "src/gateway/server-methods/usage.test.ts",
  "src/gateway/server-methods/usage.sessions-usage.test.ts",
];

// Gateway server tests that need a private module graph and the plain Vitest runner.
export const gatewayServerIsolatedTestFiles = [
  "src/gateway/server-chat.retired-projection.test.ts",
  "src/gateway/server-plugin-subagent-runtime.overrides.test.ts",
  // Loads the real plugin runtime that neighboring server tests replace with mocks.
  "src/gateway/server.chat-cli-auth.test.ts",
  "src/gateway/server.placement-abandonment.test.ts",
  "src/gateway/server.sessions.compaction-read-errors.test.ts",
];

export const gatewayServerExcludedTestFiles = [
  "src/gateway/gateway.test.ts",
  "src/gateway/server.startup-matrix-migration.integration.test.ts",
];

const gatewayServerBackedHttpTestFileSet = new Set(gatewayServerBackedHttpTestFiles);
const gatewayServerExcludedTestFileSet = new Set(gatewayServerExcludedTestFiles);
const gatewayServerIsolatedTestFileSet = new Set(gatewayServerIsolatedTestFiles);

export function isGatewayServerBackedHttpTestFile(file) {
  return gatewayServerBackedHttpTestFileSet.has(file.replaceAll("\\", "/"));
}

export function isGatewayServerTestFile(file) {
  const normalized = file.replaceAll("\\", "/");
  if (
    gatewayServerExcludedTestFileSet.has(normalized) ||
    gatewayDatabaseWorkerTestFiles.includes(normalized) ||
    gatewayServerIsolatedTestFileSet.has(normalized) ||
    normalized.startsWith("src/gateway/server-methods/") ||
    normalized.endsWith(".e2e.test.ts")
  ) {
    return false;
  }
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    isGatewayServerBackedHttpTestFile(normalized) ||
    (normalized.startsWith("src/gateway/") &&
      basename.includes("server") &&
      normalized.endsWith(".test.ts"))
  );
}
