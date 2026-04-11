// Octopus Orchestrator — Integration entry point
//
// Single function that wires Octopus into a running OpenClaw Gateway.
// Called once during Gateway startup, gated behind `octo.enabled`.
//
// This file is the SOLE integration surface between src/octo/ and the
// rest of OpenClaw. It replaces the 11 scattered upstream PR patches
// with a single, clean call:
//
//   import { initOctopus } from "./octo/index.js";
//   if (octoConfig.enabled) {
//     const octo = await initOctopus({ config, ... });
//     // spread octo.methods into gatewayMethods
//     // spread octo.handlers into extraHandlers
//     // spread octo.events into GATEWAY_EVENTS
//   }
//
// Design rationale (Option C from the integration analysis):
//   - ONE upstream change (call initOctopus in server.impl.ts) instead
//     of 11 scattered patches touching Gateway, config, CLI, agents, etc.
//   - All internal wiring goes through the src/octo/adapters/openclaw/
//     bridge layer per OCTO-DEC-033
//   - Failure to init (missing deps, bad config) is a clean error, not
//     a partial-init with dangling state
//
// What this file does NOT do:
//   - It does NOT import from any OpenClaw internal module directly.
//     Everything flows through the bridge interfaces injected via deps.
//   - It does NOT modify the OpenClaw config loader or schema — the
//     loadOctoConfig function is called by the consumer and passed in.
//   - It does NOT register CLI subcommands or agent tools — those are
//     returned as data structures the consumer wires into their own
//     registries.

import { loadOctoConfig } from "./config/loader.ts";
import { DEFAULT_OCTO_CONFIG, type OctoConfig } from "./config/schema.ts";
import { ApprovalService } from "./head/approvals.ts";
import { ArtifactService } from "./head/artifacts.ts";
import { ClaimService } from "./head/claims.ts";
import { EventLogService } from "./head/event-log.ts";
import { GraphEvaluator } from "./head/graph-evaluator.ts";
import { GripLifecycleService } from "./head/grip-lifecycle.ts";
import { LeaseService } from "./head/leases.ts";
import { OctoLogger, consoleLoggerProvider, type LoggerProvider } from "./head/logging.ts";
import { OctoMetrics, noopMetricsProvider, type MetricsProvider } from "./head/metrics.ts";
import { PolicyService, type PolicyProfile } from "./head/policy.ts";
import { QuarantineService } from "./head/quarantine.ts";
import { RegistryService } from "./head/registry.ts";
import { RetryService } from "./head/retry.ts";
import { SchedulerService } from "./head/scheduler.ts";
import { openOctoRegistry, closeOctoRegistry } from "./head/storage/migrate.ts";
import { NodeAgent } from "./node-agent/agent.ts";
// createAdapter and EventNormalizer are available for advanced consumers
// but not wired directly in initOctopus (the handlers use them internally)
import { TmuxManager } from "./node-agent/tmux-manager.ts";
import { OCTO_TOOL_SCHEMA_REGISTRY, OCTO_TOOL_NAMES } from "./tools/schemas.ts";
import { OCTO_PUSH_EVENT_NAMES } from "./wire/events.ts";
import { buildFeaturesOcto, DEFAULT_FEATURES_OCTO_CAPABILITIES } from "./wire/features.ts";
import { OctoGatewayHandlers, type OctoGatewayHandlerDeps } from "./wire/gateway-handlers.ts";
import { OCTO_METHOD_NAMES } from "./wire/methods.ts";

// ══════════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Dependencies the consumer (Gateway startup) injects. These are the
 * bridge points between OpenClaw core and the Octopus subsystem.
 */
export interface OctopusDeps {
  /** The raw parsed openclaw.json config object. initOctopus extracts
   *  the `octo:` block via loadOctoConfig. */
  rawConfig: Readonly<Record<string, unknown>>;

  /** This node's identifier. Used for arm row population + lease
   *  ownership. Typically the Gateway's device ID. */
  nodeId: string;

  /** Optional metrics provider. Defaults to no-op. */
  metricsProvider?: MetricsProvider;

  /** Optional logger provider. Defaults to console. */
  loggerProvider?: LoggerProvider;

  /** Optional policy profiles for PolicyService. Defaults to empty
   *  (open policy — everything allowed). */
  policyProfiles?: Map<string, PolicyProfile>;
}

/**
 * The initialized Octopus subsystem. The consumer wires these outputs
 * into its own registries (Gateway methods, tools, CLI, etc.).
 */
export interface OctopusInstance {
  /** The resolved, validated octo: config block. */
  config: OctoConfig;

  /** Method names to spread into the Gateway's gatewayMethods array. */
  methodNames: readonly string[];

  /** Push event names to spread into the Gateway's GATEWAY_EVENTS array. */
  pushEventNames: readonly string[];

  /** WS method handlers to spread into attachGatewayWsHandlers.extraHandlers.
   *  Keyed by method name (e.g., "octo.arm.spawn"). */
  handlers: Record<string, (params: unknown) => Promise<unknown>>;

  /** features.octo descriptor for the hello-ok handshake. */
  featuresOcto: ReturnType<typeof buildFeaturesOcto>;

  /** Agent tool definitions to register in the tool catalog.
   *  Each entry has { params (TypeBox schema), kind ("read_only" | "writer") }. */
  tools: typeof OCTO_TOOL_SCHEMA_REGISTRY;

  /** Tool names for allowlist integration. */
  toolNames: readonly string[];

  /** Graceful shutdown. Closes the DB, stops the Node Agent loop. */
  shutdown: () => Promise<void>;

  /** The underlying services, exposed for advanced consumers (CLI, tests). */
  services: {
    registry: RegistryService;
    eventLog: EventLogService;
    scheduler: SchedulerService;
    claims: ClaimService;
    artifacts: ArtifactService;
    leases: LeaseService;
    policy: PolicyService;
    approvals: ApprovalService;
    quarantine: QuarantineService;
    retry: RetryService;
    graphEvaluator: GraphEvaluator;
    gripLifecycle: GripLifecycleService;
    handlers: OctoGatewayHandlers;
    nodeAgent: NodeAgent;
    metrics: OctoMetrics;
    logger: OctoLogger;
  };
}

/**
 * Initialize the Octopus Orchestrator subsystem.
 *
 * Call this once during Gateway startup, gated behind `octo.enabled`.
 * Returns an OctopusInstance whose outputs the consumer wires into its
 * own registries.
 *
 * Example usage in server.impl.ts:
 *
 *   const octoConfig = loadOctoConfig(configSnapshot.config);
 *   if (octoConfig.enabled) {
 *     const octo = await initOctopus({
 *       rawConfig: configSnapshot.config,
 *       nodeId: deviceId,
 *     });
 *     gatewayMethods.push(...octo.methodNames);
 *     Object.assign(extraHandlers, octo.handlers);
 *     // ... wire tools, features, etc.
 *   }
 */
export async function initOctopus(deps: OctopusDeps): Promise<OctopusInstance> {
  const logProvider = deps.loggerProvider ?? consoleLoggerProvider;
  const logger = new OctoLogger("octo:init", logProvider);

  // 1. Load and validate config
  const config = loadOctoConfig(deps.rawConfig, {
    logger: (msg) => logger.info(msg),
  });

  if (!config.enabled) {
    throw new Error(
      "initOctopus called but octo.enabled is false. " +
        "Gate the call behind `if (octoConfig.enabled)` in the startup path.",
    );
  }

  logger.info("initializing Octopus Orchestrator subsystem");

  // 2. Open storage — use configured paths only when absolute (user overrides).
  // Relative paths in DEFAULT_OCTO_CONFIG are subpaths meant to be resolved
  // by the storage layer's default resolver (which prepends ~/.openclaw/).
  const isAbsPath = (p: string): boolean => p.startsWith("/");
  const registryOpts = isAbsPath(config.storage.registryPath)
    ? { path: config.storage.registryPath }
    : {};
  const db = openOctoRegistry(registryOpts);
  const registry = new RegistryService(db);
  const eventLogOpts = isAbsPath(config.storage.eventsPath)
    ? { path: config.storage.eventsPath }
    : {};
  const eventLog = new EventLogService(eventLogOpts);

  // 3. Initialize metrics
  const metricsProvider = deps.metricsProvider ?? noopMetricsProvider;
  const metrics = new OctoMetrics(metricsProvider);

  // 4. Initialize services
  const scheduler = new SchedulerService(registry, eventLog, config.scheduler);
  const claims = new ClaimService(registry, eventLog, db);
  const artifacts = new ArtifactService(db, eventLog);
  const leases = new LeaseService(db, eventLog, config.lease);
  const policy = new PolicyService(
    config.policy,
    deps.policyProfiles ?? new Map(),
    new OctoLogger("octo:policy", logProvider),
  );
  const approvals = new ApprovalService(eventLog);
  const quarantine = new QuarantineService(registry, eventLog, config.quarantine);
  const retry = new RetryService(config.retryPolicyDefault);
  const graphEvaluator = new GraphEvaluator(registry, eventLog);
  const gripLifecycle = new GripLifecycleService(registry, eventLog);

  // 5. Initialize adapters + Node Agent
  const tmuxManager = new TmuxManager();

  const handlerDeps: OctoGatewayHandlerDeps = {
    registry,
    eventLog,
    tmuxManager,
    nodeId: deps.nodeId,
    leaseService: leases,
    policyService: policy,
  };
  const handlers = new OctoGatewayHandlers(handlerDeps);

  // 6. Start Node Agent (reconcile + polling loop)
  const nodeAgent = new NodeAgent({
    nodeId: deps.nodeId,
    registry,
    eventLog,
    tmuxManager,
    pollIntervalMs: 1000,
  });
  let reconciliationReport;
  try {
    reconciliationReport = await nodeAgent.start();
  } catch (err) {
    closeOctoRegistry(db);
    throw err;
  }
  logger.info(
    `node agent started: ${reconciliationReport.recovered_count} arms recovered, ` +
      `${reconciliationReport.orphan_count} orphans, ${reconciliationReport.missing_count} missing`,
  );

  // 7. Build features descriptor
  const featuresOcto = buildFeaturesOcto({
    enabled: true,
    adapters: ["structured_subagent", "cli_exec", "pty_tmux", "structured_acp"],
    capabilities: DEFAULT_FEATURES_OCTO_CAPABILITIES,
  });

  // 8. Build method handler map for Gateway WS dispatch
  const methodHandlers: Record<string, (params: unknown) => Promise<unknown>> = {
    "octo.arm.spawn": (p) => handlers.armSpawn(p as never),
    "octo.arm.health": (p) => handlers.armHealth(p as never),
    "octo.arm.terminate": (p) => handlers.armTerminate(p as never),
    "octo.arm.send": (p) => handlers.armSend(p as never),
    "octo.arm.attach": (p) => handlers.armAttach(p as never),
    "octo.arm.checkpoint": (p) => handlers.armCheckpoint(p as never),
    "octo.mission.create": (p) => handlers.missionCreate(p as never),
    "octo.mission.pause": (p) => handlers.missionPause(p as never),
    "octo.mission.resume": (p) => handlers.missionResume(p as never),
    "octo.mission.abort": (p) => handlers.missionAbort(p as never),
    "octo.lease.renew": (p) => handlers.leaseRenew(p as never),
    "octo.node.capabilities": (p) => handlers.nodeCapabilities(p as never),
    "octo.node.reconcile": (p) => handlers.nodeReconcile(p as never),
  };

  // 9. Shutdown function — drain node-agent work before closing registry
  const shutdown = async (): Promise<void> => {
    logger.info("shutting down Octopus Orchestrator");
    nodeAgent.stop();
    closeOctoRegistry(db);
    logger.info("Octopus Orchestrator shut down");
  };

  logger.info("Octopus Orchestrator initialized successfully");

  return {
    config,
    methodNames: [...OCTO_METHOD_NAMES],
    pushEventNames: [...OCTO_PUSH_EVENT_NAMES],
    handlers: methodHandlers,
    featuresOcto,
    tools: OCTO_TOOL_SCHEMA_REGISTRY,
    toolNames: [...OCTO_TOOL_NAMES],
    shutdown,
    services: {
      registry,
      eventLog,
      scheduler,
      claims,
      artifacts,
      leases,
      policy,
      approvals,
      quarantine,
      retry,
      graphEvaluator,
      gripLifecycle,
      handlers,
      nodeAgent,
      metrics,
      logger,
    },
  };
}

// Re-export key types for consumers
export { loadOctoConfig } from "./config/loader.ts";
export { DEFAULT_OCTO_CONFIG } from "./config/schema.ts";
export type { OctoConfig } from "./config/schema.ts";
