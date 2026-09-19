// Plugin integration tests retain Gateway runtime setup outside core source.
export const gatewayPluginTestFiles = [
  "test/plugins/codex-model-catalog.gateway.test.ts",
  "test/plugins/crabbox-allocation-authority.gateway.test.ts",
];

// This curated cohort retains serial forks and the extended database-worker watchdog,
// even though ordinary Gateway methods also use forks.
export const gatewayDatabaseWorkerTestFiles = [
  "src/gateway/agent-turn/agent-run-dispatch.sqlite.test.ts",
  "src/gateway/chat-display-projection.cron.test.ts",
  "src/gateway/config-reload.activation.integration.test.ts",
  "src/gateway/config-reload.test.ts",
  "src/gateway/config-reload.transcripts.test.ts",
  "src/gateway/device-pairing-prune.test.ts",
  "src/gateway/gateway-auth-recovery.test.ts",
  "src/gateway/gateway-cli-backend.connect.test.ts",
  "src/gateway/gateway-code-mode-clock.test.ts",
  "src/gateway/gateway-cron-process-identity.windows.test.ts",
  "src/gateway/gateway-route-model-reuse.test.ts",
  "src/gateway/gateway-ssh-upload-signal.test.ts",
  "src/gateway/gateway.chat-redaction.test.ts",
  "src/gateway/health/collector.queue-health.test.ts",
  "src/gateway/internal-source-reply-persistence.test.ts",
  "src/gateway/link-understanding.product.test.ts",
  "src/gateway/local-request-context.session-tools.test.ts",
  "src/gateway/local-request-context.test.ts",
  "src/gateway/managed-image-attachments.sqlite-visibility.test.ts",
  "src/gateway/managed-image-attachments.test.ts",
  "src/gateway/managed-image-record-store.test.ts",
  "src/gateway/managed-outgoing-gc-availability.test.ts",
  "src/gateway/probe.device-auth-scope.test.ts",
  "src/gateway/server-methods/agent.create-event.test.ts",
  "src/gateway/server-methods/chat-send-commentary-media.test.ts",
  "src/gateway/server-methods/chat-send-synthetic-repair.integration.test.ts",
  "src/gateway/server-methods/chat.abort-live-proof.test.ts",
  "src/gateway/server-methods/cron.list-scoped.test.ts",
  "src/gateway/server-methods/cron.runs.test.ts",
  "src/gateway/server-methods/cron.scheduled-policy-adoption.integration.test.ts",
  "src/gateway/server-methods/cron.self-removal.test.ts",
  "src/gateway/server-methods/cron.validation.test.ts",
  "src/gateway/server-methods/models-auth-api-key.integration.test.ts",
  "src/gateway/server-methods/models-auth-login.catalog.integration.test.ts",
  "src/gateway/server-methods/models-auth-refresh.catalog.integration.test.ts",
  "src/gateway/server-methods/models-auth-refresh.integration.test.ts",
  "src/gateway/server-methods/models-auth-removal.integration.test.ts",
  "src/gateway/server-methods/models-connect-publication.integration.test.ts",
  "src/gateway/server-methods/models-dispatch.catalog.integration.test.ts",
  "src/gateway/server-methods/models-dispatch.lifecycle.integration.test.ts",
  "src/gateway/server-methods/models-list.discovery-lifecycle.integration.test.ts",
  "src/gateway/server-methods/models-list.freshness.integration.test.ts",
  "src/gateway/server-methods/models-list.membership.integration.test.ts",
  "src/gateway/server-methods/models-list.native-lifecycle.integration.test.ts",
  "src/gateway/server-methods/models-list.worker-recovery.integration.test.ts",
  "src/gateway/server-methods/native-hook-relay.test.ts",
  "src/gateway/server-methods/nodes.test.ts",
  "src/gateway/server-methods/projects.test.ts",
  "src/gateway/server-methods/requester-cron-authority.integration.test.ts",
  "src/gateway/server-methods/send.scheduled-reads.integration.test.ts",
  "src/gateway/server-methods/server-methods.test.ts",
  "src/gateway/server-methods/session-catalog.performance.test.ts",
  "src/gateway/server-methods/session-creator-preparation.test.ts",
  "src/gateway/server-methods/sessions-create-thinking-claim.test.ts",
  "src/gateway/server-methods/sessions-create-worktree-base.test.ts",
  "src/gateway/server-methods/sessions-describe-worker.test.ts",
  "src/gateway/server-methods/sessions-list-persisted-worker.test.ts",
  "src/gateway/server-methods/sessions-read-active.test.ts",
  "src/gateway/server-methods/sessions-read-async.test.ts",
  "src/gateway/server-methods/sessions-read-cache.test.ts",
  "src/gateway/server-methods/sessions-read-catalog-scope.test.ts",
  "src/gateway/server-methods/sessions-read-diagnostics.test.ts",
  "src/gateway/server-methods/sessions-read-visibility.test.ts",
  "src/gateway/server-methods/sessions-read.test.ts",
  "src/gateway/server-methods/sessions-sharing.test.ts",
  "src/gateway/server-methods/worktrees.authorization.test.ts",
  "src/gateway/server-methods/worktrees.test.ts",
  "src/gateway/server.sessions.create-worktree-spawn.test.ts",
  "src/gateway/server.sessions.create.projects.test.ts",
  "src/gateway/server/skill-library-read.test.ts",
  "src/gateway/server/ws-connection/connect-device-pairing.test.ts",
  "src/gateway/session-delivery-clock-jump.integration.test.ts",
  "src/gateway/session-repository-materialization.test.ts",
  "src/gateway/session-repository-publication-handoff.test.ts",
  "src/gateway/session-swarm-summary.test.ts",
  "src/gateway/session-utils-store-lookup.test.ts",
  "src/gateway/session-utils.agent-models.test.ts",
  "src/gateway/session-utils.queued-collector-admission.test.ts",
  "src/gateway/session-utils.queued-collector.test.ts",
  "src/gateway/session-utils.subagent.test.ts",
  "src/gateway/session-utils.test.ts",
  "src/gateway/setup-inference.first-signin.integration.test.ts",
  "src/gateway/startup-local-cli-pairing.test.ts",
  "src/gateway/test-helpers.acquisition.test.ts",
  "src/gateway/tool-resolution.cron-capture.test.ts",
  "src/gateway/worker-environments/provider-crabbox-runtime-preflight.test.ts",
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
  // Heap scans should not traverse objects from unrelated test files.
  "src/gateway/server-methods/chat-metadata-runtime.cache.test.ts",
  "src/gateway/server-methods/tasks.access.test.ts",
  "src/gateway/server-methods/tasks.test.ts",
  "src/gateway/server-methods/agent.task-runtime.test.ts",
  "src/gateway/server-methods/agent.test.ts",
  "src/gateway/server-methods/board.runtime-boundaries.test.ts",
  "src/gateway/server-methods/chat.reset-visible-yield.test.ts",
  "src/gateway/server-methods/environments.pairing-snapshot.test.ts",
  // Status uses the host-owned shared SQLite broker.
  "src/gateway/server-methods/health.owner-routing.test.ts",
  "src/gateway/server-methods/sessions.send-yield-resume.test.ts",
  "src/gateway/server-methods/system-agent-nested-inference.integration.test.ts",
  "src/gateway/server-methods/system-agent-setup-control-ui.test.ts",
  "src/gateway/server-methods/transcripts.test.ts",
  "src/gateway/server-methods/users-preferences.test.ts",
  "src/gateway/server-methods/usage.test.ts",
  "src/gateway/server-methods/usage.sessions-usage.test.ts",
];

// Gateway server tests that need a private module graph and the plain Vitest runner.
export const gatewayServerIsolatedTestFiles = [
  // A failed native close permanently fences this process's metadata owner.
  "src/gateway/server-close.agent-databases.test.ts",
  "src/gateway/server-chat.retired-projection.test.ts",
  "src/gateway/server-plugin-subagent-runtime.overrides.test.ts",
  // Loads the real plugin runtime that neighboring server tests replace with mocks.
  "src/gateway/server.chat-cli-auth.test.ts",
  "src/gateway/server.chat-recovered-output.test.ts",
  "src/gateway/server.cli-watchdog.test.ts",
  "src/gateway/server.codex-failure-recovery.test.ts",
  "src/gateway/server.incomplete-stream.test.ts",
  "src/gateway/server.placement-abandonment.lifecycle.test.ts",
  "src/gateway/server.placement-abandonment.test.ts",
  "src/gateway/server.sessions.compaction-read-errors.test.ts",
  "src/gateway/server.xai-fallback.test.ts",
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
