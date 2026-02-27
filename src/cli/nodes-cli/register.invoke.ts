import type { Command } from "commander";
import { resolveAgentConfig, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { randomIdempotencyKey } from "../../gateway/call.js";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  maxAsk,
  minSecurity,
  resolveExecApprovalsFromFile,
} from "../../infra/exec-approvals.js";
import { buildNodeShellCommand } from "../../infra/node-shell.js";
import { applyPathPrepend } from "../../infra/path-prepend.js";
import { parsePreparedSystemRunPayload } from "../../infra/system-run-approval-context.js";
import { defaultRuntime } from "../../runtime.js";
import { parseEnvPairs, parseTimeoutMs } from "../nodes-run.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { parseNodeList } from "./format.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId, unauthorizedHintForMessage } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

type NodesRunOpts = NodesRpcOpts & {
  node?: string;
  cwd?: string;
  env?: string[];
  commandTimeout?: string;
  needsScreenRecording?: boolean;
  invokeTimeout?: string;
  idempotencyKey?: string;
  agent?: string;
  ask?: string;
  security?: string;
  raw?: string;
};

type ExecDefaults = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  node?: string;
  pathPrepend?: string[];
  safeBins?: string[];
};

function normalizeExecSecurity(value?: string | null): ExecSecurity | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

function normalizeExecAsk(value?: string | null): ExecAsk | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized as ExecAsk;
  }
  return null;
}

function resolveExecDefaults(
  cfg: ReturnType<typeof loadConfig>,
  agentId: string | undefined,
): ExecDefaults | undefined {
  const globalExec = cfg?.tools?.exec;
  if (!agentId) {
    return globalExec
      ? {
          security: globalExec.security,
          ask: globalExec.ask,
          node: globalExec.node,
          pathPrepend: globalExec.pathPrepend,
          safeBins: globalExec.safeBins,
        }
      : undefined;
  }
  const agentExec = resolveAgentConfig(cfg, agentId)?.tools?.exec;
  return {
    security: agentExec?.security ?? globalExec?.security,
    ask: agentExec?.ask ?? globalExec?.ask,
    node: agentExec?.node ?? globalExec?.node,
    pathPrepend: agentExec?.pathPrepend ?? globalExec?.pathPrepend,
    safeBins: agentExec?.safeBins ?? globalExec?.safeBins,
  };
}

async function resolveNodePlatform(opts: NodesRpcOpts, nodeId: string): Promise<string | null> {
  try {
    const res = await callGatewayCli("node.list", opts, {});
    const nodes = parseNodeList(res);
    const match = nodes.find((node) => node.nodeId === nodeId);
    return typeof match?.platform === "string" ? match.platform : null;
  } catch {
    return null;
  }
}

function requirePreparedRunPayload(payload: unknown) {
  const prepared = parsePreparedSystemRunPayload(payload);
  if (!prepared) {
    throw new Error("invalid system.run.prepare response");
  }
  return prepared;
}

function resolveNodesRunPolicy(opts: NodesRunOpts, execDefaults: ExecDefaults | undefined) {
  const configuredSecurity = normalizeExecSecurity(execDefaults?.security) ?? "allowlist";
  const requestedSecurity = normalizeExecSecurity(opts.security);
  if (opts.security && !requestedSecurity) {
    throw new Error("invalid --security (use deny|allowlist|full)");
  }
  const configuredAsk = normalizeExecAsk(execDefaults?.ask) ?? "on-miss";
  const requestedAsk = normalizeExecAsk(opts.ask);
  if (opts.ask && !requestedAsk) {
    throw new Error("invalid --ask (use off|on-miss|always)");
  }
  return {
    security: minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity),
    ask: maxAsk(configuredAsk, requestedAsk ?? configuredAsk),
  };
}

async function prepareNodesRunContext(params: {
  opts: NodesRunOpts;
  command: string[];
  raw: string;
  nodeId: string;
  agentId: string | undefined;
  execDefaults: ExecDefaults | undefined;
}) {
  const env = parseEnvPairs(params.opts.env);
  const timeoutMs = parseTimeoutMs(params.opts.commandTimeout);
  const invokeTimeout = parseTimeoutMs(params.opts.invokeTimeout);

  let argv = Array.isArray(params.command) ? params.command : [];
  let rawCommand: string | undefined;
  if (params.raw) {
    rawCommand = params.raw;
    const platform = await resolveNodePlatform(params.opts, params.nodeId);
    argv = buildNodeShellCommand(rawCommand, platform ?? undefined);
  }

  const nodeEnv = env ? { ...env } : undefined;
  if (nodeEnv) {
    applyPathPrepend(nodeEnv, params.execDefaults?.pathPrepend, { requireExisting: true });
  }

  const prepareResponse = (await callGatewayCli("node.invoke", params.opts, {
    nodeId: params.nodeId,
    command: "system.run.prepare",
    params: {
      command: argv,
      rawCommand,
      cwd: params.opts.cwd,
      agentId: params.agentId,
    },
    idempotencyKey: `prepare-${randomIdempotencyKey()}`,
  })) as { payload?: unknown } | null;

  return {
    prepared: requirePreparedRunPayload(prepareResponse?.payload),
    nodeEnv,
    timeoutMs,
    invokeTimeout,
  };
}

async function resolveNodeApprovals(params: {
  opts: NodesRunOpts;
  nodeId: string;
  agentId: string | undefined;
  security: ExecSecurity;
  ask: ExecAsk;
}) {
  const approvalsSnapshot = (await callGatewayCli("exec.approvals.node.get", params.opts, {
    nodeId: params.nodeId,
  })) as {
    file?: unknown;
  } | null;
  const approvalsFile =
    approvalsSnapshot && typeof approvalsSnapshot === "object" ? approvalsSnapshot.file : undefined;
  if (!approvalsFile || typeof approvalsFile !== "object") {
    throw new Error("exec approvals unavailable");
  }
  const approvals = resolveExecApprovalsFromFile({
    file: approvalsFile as ExecApprovalsFile,
    agentId: params.agentId,
    overrides: { security: params.security, ask: params.ask },
  });
  return {
    approvals,
    hostSecurity: minSecurity(params.security, approvals.agent.security),
    hostAsk: maxAsk(params.ask, approvals.agent.ask),
    askFallback: approvals.agent.askFallback,
  };
}

async function maybeRequestNodesRunApproval(params: {
  opts: NodesRunOpts;
  nodeId: string;
  agentId: string | undefined;
  preparedCmdText: string;
  approvalPlan: ReturnType<typeof requirePreparedRunPayload>["plan"];
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback: ExecSecurity;
}) {
  let approvedByAsk = false;
  let approvalDecision: "allow-once" | "allow-always" | null = null;
  let approvalId: string | null = null;
  const requiresAsk = params.hostAsk === "always" || params.hostAsk === "on-miss";
  if (!requiresAsk) {
    return { approvedByAsk, approvalDecision, approvalId };
  }

  approvalId = crypto.randomUUID();
  const approvalTimeoutMs = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
  // Keep client transport alive while the approver decides.
  const transportTimeoutMs = Math.max(
    parseTimeoutMs(params.opts.timeout) ?? 0,
    approvalTimeoutMs + 10_000,
  );
  const decisionResult = (await callGatewayCli(
    "exec.approval.request",
    params.opts,
    {
      id: approvalId,
      command: params.preparedCmdText,
      commandArgv: params.approvalPlan.argv,
      systemRunPlanV2: params.approvalPlan,
      cwd: params.approvalPlan.cwd,
      nodeId: params.nodeId,
      host: "node",
      security: params.hostSecurity,
      ask: params.hostAsk,
      agentId: params.approvalPlan.agentId ?? params.agentId,
      resolvedPath: undefined,
      sessionKey: params.approvalPlan.sessionKey ?? undefined,
      timeoutMs: approvalTimeoutMs,
    },
    { transportTimeoutMs },
  )) as { decision?: string } | null;
  const decision =
    decisionResult && typeof decisionResult === "object" ? (decisionResult.decision ?? null) : null;
  if (decision === "deny") {
    throw new Error("exec denied: user denied");
  }
  if (!decision) {
    if (params.askFallback === "full") {
      approvedByAsk = true;
      approvalDecision = "allow-once";
    } else if (params.askFallback !== "allowlist") {
      throw new Error("exec denied: approval required (approval UI not available)");
    }
  }
  if (decision === "allow-once") {
    approvedByAsk = true;
    approvalDecision = "allow-once";
  }
  if (decision === "allow-always") {
    approvedByAsk = true;
    approvalDecision = "allow-always";
  }
  return { approvedByAsk, approvalDecision, approvalId };
}

function buildSystemRunInvokeParams(params: {
  nodeId: string;
  approvalPlan: ReturnType<typeof requirePreparedRunPayload>["plan"];
  nodeEnv: Record<string, string> | undefined;
  timeoutMs: number | undefined;
  invokeTimeout: number | undefined;
  approvedByAsk: boolean;
  approvalDecision: "allow-once" | "allow-always" | null;
  approvalId: string | null;
  idempotencyKey: string | undefined;
  fallbackAgentId: string | undefined;
  needsScreenRecording: boolean;
}) {
  const invokeParams: Record<string, unknown> = {
    nodeId: params.nodeId,
    command: "system.run",
    params: {
      command: params.approvalPlan.argv,
      rawCommand: params.approvalPlan.rawCommand,
      cwd: params.approvalPlan.cwd,
      env: params.nodeEnv,
      timeoutMs: params.timeoutMs,
      needsScreenRecording: params.needsScreenRecording,
    },
    idempotencyKey: String(params.idempotencyKey ?? randomIdempotencyKey()),
  };
  if (params.approvalPlan.agentId ?? params.fallbackAgentId) {
    (invokeParams.params as Record<string, unknown>).agentId =
      params.approvalPlan.agentId ?? params.fallbackAgentId;
  }
  if (params.approvalPlan.sessionKey) {
    (invokeParams.params as Record<string, unknown>).sessionKey = params.approvalPlan.sessionKey;
  }
  (invokeParams.params as Record<string, unknown>).approved = params.approvedByAsk;
  if (params.approvalDecision) {
    (invokeParams.params as Record<string, unknown>).approvalDecision = params.approvalDecision;
  }
  if (params.approvedByAsk && params.approvalId) {
    (invokeParams.params as Record<string, unknown>).runId = params.approvalId;
  }
  if (params.invokeTimeout !== undefined) {
    invokeParams.timeoutMs = params.invokeTimeout;
  }
  return invokeParams;
}

export function registerNodesInvokeCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("invoke")
      .description("Invoke a command on a paired node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--command <command>", "Command (e.g. canvas.eval)")
      .option("--params <json>", "JSON object string for params", "{}")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 15000)", "15000")
      .option("--idempotency-key <key>", "Idempotency key (optional)")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("invoke", async () => {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const command = String(opts.command ?? "").trim();
          if (!nodeId || !command) {
            const { error } = getNodesTheme();
            defaultRuntime.error(error("--node and --command required"));
            defaultRuntime.exit(1);
            return;
          }
          const params = JSON.parse(String(opts.params ?? "{}")) as unknown;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command,
            params,
            idempotencyKey: String(opts.idempotencyKey ?? randomIdempotencyKey()),
          };
          if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
            invokeParams.timeoutMs = timeoutMs;
          }

          const result = await callGatewayCli("node.invoke", opts, invokeParams);
          defaultRuntime.log(JSON.stringify(result, null, 2));
        });
      }),
    { timeoutMs: 30_000 },
  );

  nodesCallOpts(
    nodes
      .command("run")
      .description("Run a shell command on a node (mac only)")
      .option("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--cwd <path>", "Working directory")
      .option(
        "--env <key=val>",
        "Environment override (repeatable)",
        (value: string, prev: string[] = []) => [...prev, value],
      )
      .option("--raw <command>", "Run a raw shell command string (sh -lc / cmd.exe /c)")
      .option("--agent <id>", "Agent id (default: configured default agent)")
      .option("--ask <mode>", "Exec ask mode (off|on-miss|always)")
      .option("--security <mode>", "Exec security mode (deny|allowlist|full)")
      .option("--command-timeout <ms>", "Command timeout (ms)")
      .option("--needs-screen-recording", "Require screen recording permission")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 30000)", "30000")
      .argument("[command...]", "Command and args")
      .action(async (command: string[], opts: NodesRunOpts) => {
        await runNodesCommand("run", async () => {
          const cfg = loadConfig();
          const agentId = opts.agent?.trim() || resolveDefaultAgentId(cfg);
          const execDefaults = resolveExecDefaults(cfg, agentId);
          const raw = typeof opts.raw === "string" ? opts.raw.trim() : "";
          if (raw && Array.isArray(command) && command.length > 0) {
            throw new Error("use --raw or argv, not both");
          }
          if (!raw && (!Array.isArray(command) || command.length === 0)) {
            throw new Error("command required");
          }

          const nodeQuery = String(opts.node ?? "").trim() || execDefaults?.node?.trim() || "";
          if (!nodeQuery) {
            throw new Error("node required (set --node or tools.exec.node)");
          }
          const nodeId = await resolveNodeId(opts, nodeQuery);
          const preparedContext = await prepareNodesRunContext({
            opts,
            command,
            raw,
            nodeId,
            agentId,
            execDefaults,
          });
          const approvalPlan = preparedContext.prepared.plan;
          const policy = resolveNodesRunPolicy(opts, execDefaults);
          const approvals = await resolveNodeApprovals({
            opts,
            nodeId,
            agentId,
            security: policy.security,
            ask: policy.ask,
          });
          if (approvals.hostSecurity === "deny") {
            throw new Error("exec denied: host=node security=deny");
          }
          const approvalResult = await maybeRequestNodesRunApproval({
            opts,
            nodeId,
            agentId,
            preparedCmdText: preparedContext.prepared.cmdText,
            approvalPlan,
            hostSecurity: approvals.hostSecurity,
            hostAsk: approvals.hostAsk,
            askFallback: approvals.askFallback,
          });
          const invokeParams = buildSystemRunInvokeParams({
            nodeId,
            approvalPlan,
            nodeEnv: preparedContext.nodeEnv,
            timeoutMs: preparedContext.timeoutMs,
            invokeTimeout: preparedContext.invokeTimeout,
            approvedByAsk: approvalResult.approvedByAsk,
            approvalDecision: approvalResult.approvalDecision,
            approvalId: approvalResult.approvalId,
            idempotencyKey: opts.idempotencyKey,
            fallbackAgentId: agentId,
            needsScreenRecording: opts.needsScreenRecording === true,
          });

          const result = await callGatewayCli("node.invoke", opts, invokeParams);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }

          const payload =
            typeof result === "object" && result !== null
              ? (result as { payload?: Record<string, unknown> }).payload
              : undefined;

          const stdout = typeof payload?.stdout === "string" ? payload.stdout : "";
          const stderr = typeof payload?.stderr === "string" ? payload.stderr : "";
          const exitCode = typeof payload?.exitCode === "number" ? payload.exitCode : null;
          const timedOut = payload?.timedOut === true;
          const success = payload?.success === true;

          if (stdout) {
            process.stdout.write(stdout);
          }
          if (stderr) {
            process.stderr.write(stderr);
          }
          if (timedOut) {
            const { error } = getNodesTheme();
            defaultRuntime.error(error("run timed out"));
            defaultRuntime.exit(1);
            return;
          }
          if (exitCode !== null && exitCode !== 0) {
            const hint = unauthorizedHintForMessage(`${stderr}\n${stdout}`);
            if (hint) {
              const { warn } = getNodesTheme();
              defaultRuntime.error(warn(hint));
            }
          }
          if (exitCode !== null && exitCode !== 0 && !success) {
            const { error } = getNodesTheme();
            defaultRuntime.error(error(`run exit ${exitCode}`));
            defaultRuntime.exit(1);
            return;
          }
        });
      }),
    { timeoutMs: 35_000 },
  );
}
