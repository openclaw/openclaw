// Keep source descriptors literal for the static worker-dependency scanner.
type SourceEntry = { currentModuleUrl: string; sourceWorkerName: string };
function worker<const T extends SourceEntry>(source: T) {
  const name = source.sourceWorkerName;
  const base = name.startsWith("../") ? name.replace(/^(?:\.\.\/)+/u, "") : `cli/${name}`;
  return { ...source, distWorkerPath: `${base}.js` } as const;
}
function legacy<const T extends SourceEntry>(source: T) {
  const entry = worker(source);
  return { ...entry, distWorkerPath: `legacy-finalizer/src/${entry.distWorkerPath}` } as const;
}

// Both concurrent writers must use the same runtime graph and version metadata.
export const cliRecoveryEntrypoints = {
  cli: worker({ currentModuleUrl: import.meta.url, sourceWorkerName: "../entry" }),
  daemon: worker({ currentModuleUrl: import.meta.url, sourceWorkerName: "daemon-cli" }),
  sessionAccessor: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../config/sessions/session-accessor",
  }),
  cliSession: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../agents/cli-session",
  }),
  doctorLintSupervisor: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../commands/doctor-lint-process",
  }),
  doctorHealth: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../extensions/memory-core/doctor-health-api",
  }),
  signalExitBarrier: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "signal-exit-barrier",
  }),
  outputDrain: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../process/output-drain",
  }),
} as const;

export const cliMessageExitEntrypoints = {
  registration: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "program/register.message",
  }),
  command: worker({ currentModuleUrl: import.meta.url, sourceWorkerName: "../commands/message" }),
  oneShotExit: worker({ currentModuleUrl: import.meta.url, sourceWorkerName: "one-shot-exit" }),
} as const;

export const doctorOutputEntrypoints = {
  maintenance: legacy({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "program/register.maintenance",
  }),
  oneShotExit: legacy({ currentModuleUrl: import.meta.url, sourceWorkerName: "one-shot-exit" }),
} as const;

// Import guards need physical module boundaries in the prepared fixture graph.
export const mcpImportBoundaryEntrypoints = {
  cli: legacy({ currentModuleUrl: import.meta.url, sourceWorkerName: "mcp-cli" }),
  catalog: legacy({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../agents/agent-bundle-mcp-materialize",
  }),
  metadata: legacy({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../plugins/tool-metadata",
  }),
} as const;

// Preserve module boundaries so a child can retire only its own cleanup source copies.
export const cliCleanupRetirementEntrypoints = {
  scope: legacy({ currentModuleUrl: import.meta.url, sourceWorkerName: "runtime-cleanup-scope" }),
  cleanup: legacy({ currentModuleUrl: import.meta.url, sourceWorkerName: "runtime-cleanup" }),
  skills: legacy({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../skills/runtime/refresh",
  }),
  database: legacy({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../state/openclaw-state-db-cache",
  }),
  workers: legacy({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/worker-native-lifecycle",
  }),
} as const;

// Compile the cleanup graph at collection, before the Windows ownership deadline starts.
export const windowsProcessOwnershipEntrypoint = worker({
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "runtime-cleanup-scope.windows.test-support",
});

export const windowsProcessJobRetentionEntrypoint = worker({
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "../process/supervisor/service-child-windows-job-native",
});

// Failure reporting and exit finalization must share their compiled error classes.
export const updateCandidateExitEntrypoints = {
  oneShotExit: worker({ currentModuleUrl: import.meta.url, sourceWorkerName: "one-shot-exit" }),
  failureTriage: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-cli/update-command-triage",
  }),
  commandResult: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-cli/update-command-result",
  }),
} as const;

// Prepare the real Gateway fixture before its readiness hook starts; source
// transforms must not consume that hook's startup deadline.
export const stateDirGatewayFixtureEntrypoint = worker({
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "state-dir-gateway-check.server-fixture.test-support",
});

export const localStateOwnerFixtureEntrypoint = worker({
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "local-state-owner.child.test-support",
});

export const adminStateOwnerFixtureEntrypoint = worker({
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "admin-state-owner.child.test-support",
});

export const updateFinalizationOutputEntrypoint = legacy({
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "update-finalization-output.test-support",
});

// Direct-stop children use the invocation's prepared graph before readiness starts.
export const gatewayDirectStopEntrypoints = {
  forcedCronFixture: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "gateway-cli/run-loop.forced-cron.test-support",
  }),
  modelAcquisitionFixture: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "gateway-cli/run-loop.model-acquisition.test-support",
  }),
  ingressDrain: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../channels/message/ingress-drain",
  }),
  ingressQueue: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../channels/message/ingress-queue",
  }),
  runs: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../agents/embedded-agent-runner/runs",
  }),
  sessionControllerAdmission: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../sessions/session-controller.admission",
  }),
  sessionControllerQueries: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../sessions/session-controller.queries",
  }),
  runLoop: worker({ currentModuleUrl: import.meta.url, sourceWorkerName: "gateway-cli/run-loop" }),
  restartPolicy: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/restart",
  }),
  workAdmission: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../process/gateway-work-admission",
  }),
} as const;

export const updateExecutorEntrypoints = {
  gatewayLock: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/gateway-lock",
  }),
  gatewayOwnerLease: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/gateway-owner-lease",
  }),
  boundaryPath: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/boundary-path",
  }),
  statePaths: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../state/openclaw-state-db.paths",
  }),
  sealedRegistry: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/sealed-runtime-registry",
  }),
  ledger: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/update-run-ledger",
  }),
  handoff: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/update-managed-service-handoff",
  }),
  sentinel: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/update-control-plane-sentinel",
  }),
  packageSteps: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/package-update-steps",
  }),
  packageFixture: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/package-update-steps.test-support",
  }),
  inventory: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/lib/package-dist-inventory",
  }),
  exec: worker({ currentModuleUrl: import.meta.url, sourceWorkerName: "../process/exec" }),
  lease: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/update-managed-service-handoff-lease",
  }),
  activation: worker({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/package-update-activation",
  }),
} as const;
