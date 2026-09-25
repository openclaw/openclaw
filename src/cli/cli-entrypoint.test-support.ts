// Both concurrent writers must use the same runtime graph and version metadata.
export const cliRecoveryEntrypoints = {
  cli: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../entry",
    distWorkerPath: "entry.js",
  },
  sessionAccessor: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../config/sessions/session-accessor",
    distWorkerPath: "config/sessions/session-accessor.js",
  },
  cliSession: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../agents/cli-session",
    distWorkerPath: "agents/cli-session.js",
  },
  doctorLintSupervisor: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../commands/doctor-lint-process",
    distWorkerPath: "commands/doctor-lint-process.js",
  },
  doctorHealth: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../extensions/memory-core/doctor-health-api",
    distWorkerPath: "extensions/memory-core/doctor-health-api.js",
  },
  signalExitBarrier: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "signal-exit-barrier",
    distWorkerPath: "cli/signal-exit-barrier.js",
  },
  outputDrain: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../process/output-drain",
    distWorkerPath: "process/output-drain.js",
  },
} as const;

// Report producers remain hookable inside the prepared CLI graph.
export const doctorOutputEntrypoints = {
  maintenance: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "program/register.maintenance",
    distWorkerPath: "legacy-finalizer/src/cli/program/register.maintenance.js",
  },
  oneShotExit: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "one-shot-exit",
    distWorkerPath: "legacy-finalizer/src/cli/one-shot-exit.js",
  },
} as const;

// Import guards need physical module boundaries in the prepared fixture graph.
export const mcpImportBoundaryEntrypoints = {
  cli: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "mcp-cli",
    distWorkerPath: "legacy-finalizer/src/cli/mcp-cli.js",
  },
  catalog: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../agents/agent-bundle-mcp-materialize",
    distWorkerPath: "legacy-finalizer/src/agents/agent-bundle-mcp-materialize.js",
  },
  metadata: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../plugins/tool-metadata",
    distWorkerPath: "legacy-finalizer/src/plugins/tool-metadata.js",
  },
} as const;

// Failure reporting and exit finalization must share their compiled error classes.
export const updateCandidateExitEntrypoints = {
  oneShotExit: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "one-shot-exit",
    distWorkerPath: "cli/one-shot-exit.js",
  },
  failureTriage: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-cli/update-command-triage",
    distWorkerPath: "cli/update-cli/update-command-triage.js",
  },
  commandResult: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-cli/update-command-result",
    distWorkerPath: "cli/update-cli/update-command-result.js",
  },
} as const;

// Prepare the real Gateway fixture before its readiness hook starts; source
// transforms must not consume that hook's startup deadline.
export const stateDirGatewayFixtureEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "state-dir-gateway-check.server-fixture.test-support",
  distWorkerPath: "cli/state-dir-gateway-check.server-fixture.test-support.js",
} as const;

export const updateFinalizationOutputEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "update-finalization-output.test-support",
  distWorkerPath: "legacy-finalizer/src/cli/update-finalization-output.test-support.js",
} as const;

// Direct-stop children use the invocation's prepared graph before readiness starts.
export const gatewayDirectStopEntrypoints = {
  startupOrphanFixture: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../gateway/startup-orphan-process.test-support",
    distWorkerPath: "gateway/startup-orphan-process.test-support.js",
  },
  forcedCronFixture: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "gateway-cli/run-loop.forced-cron.test-support",
    distWorkerPath: "cli/gateway-cli/run-loop.forced-cron.test-support.js",
  },
  modelAcquisitionFixture: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "gateway-cli/run-loop.model-acquisition.test-support",
    distWorkerPath: "cli/gateway-cli/run-loop.model-acquisition.test-support.js",
  },
  fileLogTransport: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../logging/logger-file-transport",
    distWorkerPath: "logging/logger-file-transport.js",
  },
  ingressDrain: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../channels/message/ingress-drain",
    distWorkerPath: "channels/message/ingress-drain.js",
  },
  ingressQueue: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../channels/message/ingress-queue",
    distWorkerPath: "channels/message/ingress-queue.js",
  },
  runs: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../agents/embedded-agent-runner/runs",
    distWorkerPath: "agents/embedded-agent-runner/runs.js",
  },
  activeRunProjections: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../agents/embedded-agent-runner/active-run-projections",
    distWorkerPath: "agents/embedded-agent-runner/active-run-projections.js",
  },
  runLoop: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "gateway-cli/run-loop",
    distWorkerPath: "cli/gateway-cli/run-loop.js",
  },
  restartPolicy: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/restart",
    distWorkerPath: "infra/restart.js",
  },
  workAdmission: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../process/gateway-work-admission",
    distWorkerPath: "process/gateway-work-admission.js",
  },
} as const;

// Extra update roots share the native fixture generation.
export const updateExecutorEntrypoints = {
  sealedRegistry: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/sealed-runtime-registry",
    distWorkerPath: "infra/sealed-runtime-registry.js",
  },
  ledger: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/update-run-ledger",
    distWorkerPath: "infra/update-run-ledger.js",
  },
  handoff: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/update-managed-service-handoff",
    distWorkerPath: "infra/update-managed-service-handoff.js",
  },
  sentinel: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/update-control-plane-sentinel",
    distWorkerPath: "infra/update-control-plane-sentinel.js",
  },
  packageSteps: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/package-update-steps",
    distWorkerPath: "infra/package-update-steps.js",
  },
  packageFixture: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/package-update-steps.test-support",
    distWorkerPath: "infra/package-update-steps.test-support.js",
  },
  inventory: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/lib/package-dist-inventory",
    distWorkerPath: "scripts/lib/package-dist-inventory.js",
  },
  exec: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../process/exec",
    distWorkerPath: "process/exec.js",
  },
  lease: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/update-managed-service-handoff-lease",
    distWorkerPath: "infra/update-managed-service-handoff-lease.js",
  },
  activation: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/package-update-activation",
    distWorkerPath: "infra/package-update-activation.js",
  },
} as const;
