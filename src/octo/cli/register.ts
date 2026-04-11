// Octopus Orchestrator — CLI registration adapter
//
// Registers `openclaw octo` as a top-level subcommand with verb
// handlers delegating to the per-command modules in this directory.

import type { Command } from "commander";
import { runOctoDoctor } from "./doctor.js";
import { runOctoStatus } from "./status.js";

// Shared helper: open registry + services for read-only CLI commands.
async function withRegistry<T>(
  fn: (services: {
    db: ReturnType<Awaited<typeof import("../head/storage/migrate.js")>["openOctoRegistry"]>;
    registry: InstanceType<Awaited<typeof import("../head/registry.js")>["RegistryService"]>;
    eventLog: InstanceType<Awaited<typeof import("../head/event-log.js")>["EventLogService"]>;
  }) => T,
): Promise<T> {
  const { openOctoRegistry, closeOctoRegistry } = await import("../head/storage/migrate.js");
  const { RegistryService } = await import("../head/registry.js");
  const { EventLogService } = await import("../head/event-log.js");
  let db;
  try {
    db = openOctoRegistry();
  } catch {
    console.log("Octopus Orchestrator: registry not yet initialised.");
    console.log("Run `openclaw octo init` to initialise the registry.");
    process.exit(1);
  }
  try {
    const registry = new RegistryService(db);
    const eventLog = new EventLogService();
    return await fn({ db, registry, eventLog });
  } finally {
    closeOctoRegistry(db);
  }
}

// Shared helper: open registry + construct gateway handlers for mutating CLI commands.
async function withHandlers<T>(
  fn: (services: {
    db: ReturnType<Awaited<typeof import("../head/storage/migrate.js")>["openOctoRegistry"]>;
    registry: InstanceType<Awaited<typeof import("../head/registry.js")>["RegistryService"]>;
    eventLog: InstanceType<Awaited<typeof import("../head/event-log.js")>["EventLogService"]>;
    handlers: InstanceType<
      Awaited<typeof import("../wire/gateway-handlers.js")>["OctoGatewayHandlers"]
    >;
  }) => T,
): Promise<T> {
  const { openOctoRegistry, closeOctoRegistry } = await import("../head/storage/migrate.js");
  const { RegistryService } = await import("../head/registry.js");
  const { EventLogService } = await import("../head/event-log.js");
  const { OctoGatewayHandlers } = await import("../wire/gateway-handlers.js");
  const { TmuxManager } = await import("../node-agent/tmux-manager.js");
  const { LeaseService } = await import("../head/leases.js");
  const { ArtifactService } = await import("../head/artifacts.js");
  const { PolicyService } = await import("../head/policy.js");
  const { OctoLogger, consoleLoggerProvider } = await import("../head/logging.js");
  const { DEFAULT_OCTO_CONFIG } = await import("../config/schema.js");
  const os = await import("node:os");
  let db;
  try {
    db = openOctoRegistry();
  } catch {
    console.log("Octopus Orchestrator: registry not yet initialised.");
    console.log("Run `openclaw octo init` to initialise the registry.");
    process.exit(1);
  }
  try {
    const registry = new RegistryService(db);
    const eventLog = new EventLogService();
    const tmuxManager = new TmuxManager();
    const leaseService = new LeaseService(db, eventLog, DEFAULT_OCTO_CONFIG.lease);
    const policyLogger = new OctoLogger("octo:policy:cli", consoleLoggerProvider);
    const policyService = new PolicyService(DEFAULT_OCTO_CONFIG.policy, new Map(), policyLogger);
    const artifactService = new ArtifactService(db, eventLog);
    const handlers = new OctoGatewayHandlers({
      registry,
      eventLog,
      tmuxManager,
      nodeId: os.hostname(),
      leaseService,
      policyService: policyService as never,
      artifactService,
    });
    return await fn({ db, registry, eventLog, handlers });
  } finally {
    closeOctoRegistry(db);
  }
}

export function registerOctoCli(program: Command) {
  const octo = program
    .command("octo")
    .description("Octopus Orchestrator control plane (missions, arms, grips)");

  // ── status ──────────────────────────────────────────────────────────────

  octo
    .command("status")
    .description("Show Octopus subsystem status dashboard")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const code = await withRegistry(({ registry }) => runOctoStatus(registry, opts));
      process.exit(code);
    });

  // ── doctor ──────────────────────────────────────────────────────────────

  octo
    .command("doctor")
    .description("Run Octopus health checks")
    .option("--json", "Output as JSON")
    .action((opts) => {
      const code = runOctoDoctor(opts);
      process.exit(code);
    });

  // ── init ────────────────────────────────────────────────────────────────

  octo
    .command("init")
    .description("Initialise the Octopus registry and storage")
    .action(async (opts) => {
      const { runOctoInit } = await import("./init.js");
      const code = runOctoInit(opts);
      process.exit(code);
    });

  // ── runtimes ────────────────────────────────────────────────────────────

  octo
    .command("runtimes")
    .description("Discover available agentic coding tools on this machine")
    .option("--json", "Output as JSON")
    .option("--usage", "Include local usage statistics (token counts, session history)")
    .option("--probe", "Spawn interactive TUI sessions to query live quota (takes ~30s)")
    .action(async (opts) => {
      const { runOctoRuntimes } = await import("./runtimes.js");
      const code = runOctoRuntimes(opts);
      process.exit(code);
    });

  // ── top ──────────────────────────────────────────────────────────────────

  octo
    .command("top")
    .description("Real-time TUI dashboard — missions, arms, grips, claims")
    .option("--refresh <ms>", "Refresh interval in milliseconds", "2000")
    .action(async (opts) => {
      const { runOctoTop } = await import("./top/dashboard.js");
      const code = await withRegistry(({ registry }) =>
        runOctoTop(registry, { refreshMs: parseInt(opts.refresh, 10) }),
      );
      process.exit(code);
    });

  // ── mission ─────────────────────────────────────────────────────────────

  const mission = octo.command("mission").description("Manage Octopus missions");

  mission
    .command("create")
    .description("Create a new mission")
    .requiredOption("--title <title>", "Mission title")
    .option("--owner <owner>", "Mission owner", "cli")
    .option("--grip <grips...>", "Grip IDs to include")
    .option("--idempotency-key <key>", "Idempotency key")
    .option("--policy-profile <ref>", "Policy profile reference")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const { runMissionCreate } = await import("./mission.js");
      const code = await withHandlers(({ handlers }) =>
        runMissionCreate(handlers, {
          title: opts.title,
          owner: opts.owner ?? "cli",
          gripIds: opts.grip ?? [],
          idempotencyKey: opts.idempotencyKey ?? `cli-${Date.now()}`,
          policyProfileRef: opts.policyProfile,
          json: opts.json,
        }),
      );
      process.exit(code);
    });

  mission
    .command("show <mission_id>")
    .description("Show mission details")
    .option("--json", "Output as JSON")
    .action(async (missionId, opts) => {
      const { runMissionShow } = await import("./mission.js");
      const code = await withRegistry(({ registry }) =>
        runMissionShow(registry, { missionId, json: opts.json }),
      );
      process.exit(code);
    });

  mission
    .command("list")
    .description("List all missions")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const { runMissionList } = await import("./mission.js");
      const code = await withRegistry(({ registry }) =>
        runMissionList(registry, { json: opts.json }),
      );
      process.exit(code);
    });

  mission
    .command("pause <mission_id>")
    .description("Pause a running mission")
    .option("--idempotency-key <key>", "Idempotency key")
    .option("--json", "Output as JSON")
    .action(async (missionId, opts) => {
      const { runMissionPause } = await import("./mission.js");
      const code = await withHandlers(({ handlers }) =>
        runMissionPause(handlers, {
          missionId,
          idempotencyKey: opts.idempotencyKey ?? `cli-pause-${Date.now()}`,
          json: opts.json,
        }),
      );
      process.exit(code);
    });

  mission
    .command("resume <mission_id>")
    .description("Resume a paused mission")
    .option("--idempotency-key <key>", "Idempotency key")
    .option("--json", "Output as JSON")
    .action(async (missionId, opts) => {
      const { runMissionResume } = await import("./mission.js");
      const code = await withHandlers(({ handlers }) =>
        runMissionResume(handlers, {
          missionId,
          idempotencyKey: opts.idempotencyKey ?? `cli-resume-${Date.now()}`,
          json: opts.json,
        }),
      );
      process.exit(code);
    });

  mission
    .command("abort <mission_id>")
    .description("Abort a mission")
    .option("--reason <reason>", "Abort reason", "aborted via CLI")
    .option("--idempotency-key <key>", "Idempotency key")
    .option("--json", "Output as JSON")
    .action(async (missionId, opts) => {
      const { runMissionAbort } = await import("./mission.js");
      const code = await withHandlers(({ handlers }) =>
        runMissionAbort(handlers, {
          missionId,
          reason: opts.reason ?? "aborted via CLI",
          idempotencyKey: opts.idempotencyKey ?? `cli-abort-${Date.now()}`,
          json: opts.json,
        }),
      );
      process.exit(code);
    });

  // ── arm ─────────────────────────────────────────────────────────────────

  const arm = octo.command("arm").description("Manage Octopus arms (worker agents)");

  arm
    .command("list")
    .description("List all arms")
    .option("--mission <mission_id>", "Filter by mission ID")
    .option("--node <node_id>", "Filter by node ID")
    .option("--state <state>", "Filter by arm state")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const { runArmList } = await import("./arm-list.js");
      const code = await withRegistry(({ registry }) =>
        runArmList(registry, {
          mission: opts.mission,
          node: opts.node,
          state: opts.state,
          json: opts.json,
        }),
      );
      process.exit(code);
    });

  arm
    .command("show <arm_id>")
    .description("Show arm details")
    .option("--json", "Output as JSON")
    .action(async (armId, opts) => {
      const { runArmShow } = await import("./arm-show.js");
      const code = await withRegistry(({ registry, eventLog }) =>
        runArmShow(registry, eventLog, armId, { json: opts.json }),
      );
      process.exit(code);
    });

  arm
    .command("logs <arm_id>")
    .description("Show captured output logs for an arm")
    .option("--type <type>", "Filter by artifact type (stdout-slice, stderr-slice, log)")
    .option("--json", "Output as JSON")
    .action(async (armId, opts) => {
      const { runArmLogs } = await import("./arm-logs.js");
      const { ArtifactService: ArtSvc } = await import("../head/artifacts.js");
      const code = await withRegistry(({ db, registry, eventLog }) => {
        const artSvc = new ArtSvc(db, eventLog);
        return runArmLogs(registry, artSvc, {
          arm_id: armId,
          type: opts.type,
          json: opts.json,
        });
      });
      process.exit(code);
    });

  arm
    .command("attach <arm_id>")
    .description("Attach to an arm's tmux session")
    .action(async (armId) => {
      const { runArmAttach } = await import("./arm-attach.js");
      const code = await withRegistry(({ registry }) => runArmAttach(registry, { arm_id: armId }));
      process.exit(code);
    });

  arm
    .command("spawn")
    .description("Spawn a new arm from an ArmSpec")
    .option("--spec-file <path>", "Path to a JSON file containing a complete ArmSpec")
    .option("--mission <mission_id>", "Mission ID")
    .option(
      "--adapter <type>",
      "Adapter type (structured_subagent, cli_exec, pty_tmux, structured_acp)",
    )
    .option("--runtime <name>", "Runtime name (e.g. claude-code, tmux:bash)")
    .option("--agent-id <id>", "Agent ID")
    .option("--cwd <path>", "Working directory (absolute path)")
    .option("--initial-input <text>", "Initial input / prompt for the arm")
    .option("--command <cmd>", "Command for cli_exec/pty_tmux adapters")
    .option("--args <args...>", "Arguments for the command")
    .option("--model <model>", "Model for structured_subagent/structured_acp")
    .option("--habitat <habitat>", "Desired habitat for placement")
    .option("--capability <caps...>", "Desired capabilities")
    .option("--worktree-path <path>", "Worktree path")
    .option("--policy-profile <ref>", "Policy profile reference")
    .option("--label <labels...>", "Labels as key=value pairs")
    .option("--idempotency-key <key>", "Idempotency key")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const { runArmSpawn } = await import("./arm-spawn.js");
      const code = await withHandlers(({ handlers }) =>
        runArmSpawn(handlers, {
          specFile: opts.specFile,
          mission: opts.mission,
          adapter: opts.adapter,
          runtime: opts.runtime,
          agentId: opts.agentId,
          cwd: opts.cwd,
          initialInput: opts.initialInput,
          command: opts.command,
          args: opts.args,
          model: opts.model,
          habitat: opts.habitat,
          capabilities: opts.capability,
          worktreePath: opts.worktreePath,
          policyProfile: opts.policyProfile,
          labels: opts.label,
          idempotencyKey: opts.idempotencyKey,
          json: opts.json,
        }),
      );
      process.exit(code);
    });

  arm
    .command("terminate <arm_id>")
    .description("Terminate an arm")
    .option("--reason <reason>", "Termination reason", "terminated via CLI")
    .option("--force", "Force termination without confirmation")
    .option("--json", "Output as JSON")
    .action(async (armId, opts) => {
      const { runArmTerminate } = await import("./arm-terminate.js");
      const code = await withHandlers(({ handlers }) =>
        runArmTerminate(handlers, {
          arm_id: armId,
          reason: opts.reason ?? "terminated via CLI",
          force: opts.force,
          json: opts.json,
        }),
      );
      process.exit(code);
    });

  arm
    .command("restart <arm_id>")
    .description("Restart an arm")
    .action(async (armId) => {
      const { runArmRestart } = await import("./arm-restart.js");
      const os = await import("node:os");
      const code = await withRegistry(async ({ registry, eventLog }) => {
        const { TmuxManager } = await import("../node-agent/tmux-manager.js");
        return runArmRestart(
          { registry, eventLog, tmuxManager: new TmuxManager(), nodeId: os.hostname() },
          armId,
        );
      });
      process.exit(code);
    });

  // ── grip ────────────────────────────────────────────────────────────────

  const grip = octo.command("grip").description("Manage Octopus grips (task assignments)");

  grip
    .command("list")
    .description("List all grips")
    .option("--mission <mission_id>", "Filter by mission ID")
    .option("--status <status>", "Filter by grip status")
    .option("--arm <arm_id>", "Filter by arm ID")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const { runGripList } = await import("./grip.js");
      const code = await withRegistry(({ registry }) =>
        runGripList(registry, {
          mission: opts.mission,
          status: opts.status,
          arm: opts.arm,
          json: opts.json,
        }),
      );
      process.exit(code);
    });

  grip
    .command("show <grip_id>")
    .description("Show grip details")
    .option("--json", "Output as JSON")
    .action(async (gripId, opts) => {
      const { runGripShow } = await import("./grip.js");
      const code = await withRegistry(({ registry }) =>
        runGripShow(registry, gripId, { json: opts.json }),
      );
      process.exit(code);
    });

  grip
    .command("abandon [grip_id]")
    .description("Abandon a grip (or all grips for a mission)")
    .option("--mission <mission_id>", "Abandon all non-terminal grips for this mission")
    .option("--reason <reason>", "Abandon reason", "abandoned via CLI")
    .option("--json", "Output as JSON")
    .action(async (gripId, opts) => {
      const { runGripAbandon } = await import("./grip-abandon.js");
      const code = await withRegistry(({ registry, eventLog }) =>
        runGripAbandon(registry, eventLog, {
          grip_id: gripId ?? "",
          mission: opts.mission,
          reason: opts.reason,
          json: opts.json,
        }),
      );
      process.exit(code);
    });

  grip
    .command("reassign <grip_id> <target_arm_id>")
    .description("Reassign a grip to a different arm")
    .action(async (gripId, targetArmId) => {
      const { runGripReassign } = await import("./grip.js");
      const code = await withRegistry(({ registry }) =>
        runGripReassign(registry, gripId, targetArmId),
      );
      process.exit(code);
    });

  // ── claims ──────────────────────────────────────────────────────────────

  octo
    .command("claims")
    .description("List active resource claims")
    .option("--mission <mission_id>", "Filter by mission ID")
    .option("--resource-type <type>", "Filter by resource type")
    .option("--arm <arm_id>", "Filter by arm ID")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const { runClaimsList } = await import("./claims.js");
      const code = await withRegistry(({ registry }) =>
        runClaimsList(registry, {
          mission: opts.mission,
          resource_type: opts.resourceType,
          arm: opts.arm,
          json: opts.json,
        }),
      );
      process.exit(code);
    });

  // ── events ──────────────────────────────────────────────────────────────

  octo
    .command("events")
    .description("Tail the Octopus event log")
    .option("--entity <type>", "Filter by entity type (arm, grip, mission)")
    .option("--entity-id <id>", "Filter by entity ID")
    .option("--type <type>", "Filter by event type")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const { runOctoEventsTail } = await import("./events-tail.js");
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      const code = await withRegistry(({ eventLog }) =>
        runOctoEventsTail(
          eventLog,
          {
            entity: opts.entity,
            entityId: opts.entityId,
            type: opts.type,
            json: opts.json,
          },
          ac.signal,
        ),
      );
      process.exit(code);
    });

  // ── node ────────────────────────────────────────────────────────────────

  const node = octo.command("node").description("Manage Octopus cluster nodes");

  node
    .command("list")
    .description("List cluster nodes")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const { runNodeList, createNodeRegistryView } = await import("./node.js");
      const code = await withRegistry(({ registry }) =>
        runNodeList(createNodeRegistryView(registry), { json: opts.json }),
      );
      process.exit(code);
    });

  node
    .command("show <node_id>")
    .description("Show node details")
    .option("--json", "Output as JSON")
    .action(async (nodeId, opts) => {
      const { runNodeShow, createNodeRegistryView } = await import("./node.js");
      const code = await withRegistry(({ registry }) =>
        runNodeShow(createNodeRegistryView(registry), nodeId, { json: opts.json }),
      );
      process.exit(code);
    });
}
