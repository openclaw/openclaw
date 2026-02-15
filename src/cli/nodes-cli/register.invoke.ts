import type { Command } from "commander";
import path from "node:path";
import type { NodesRpcOpts } from "./types.js";
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
import { defaultRuntime } from "../../runtime.js";
import { parseEnvPairs, parseTimeoutMs } from "../nodes-run.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { parseNodeList } from "./format.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId, unauthorizedHintForMessage } from "./rpc.js";

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

function mergePathPrepend(existing: string | undefined, prepend: string[]) {
  if (prepend.length === 0) {
    return existing;
  }
  const partsExisting = (existing ?? "")
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const part of [...prepend, ...partsExisting]) {
    if (seen.has(part)) {
      continue;
    }
    seen.add(part);
    merged.push(part);
  }
  return merged.join(path.delimiter);
}

function applyPathPrepend(
  env: Record<string, string>,
  prepend: string[] | undefined,
  options?: { requireExisting?: boolean },
) {
  if (!Array.isArray(prepend) || prepend.length === 0) {
    return;
  }
  if (options?.requireExisting && !env.PATH) {
    return;
  }
  const merged = mergePathPrepend(env.PATH, prepend);
  if (merged) {
    env.PATH = merged;
  }
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

          const env = parseEnvPairs(opts.env);
          const timeoutMs = parseTimeoutMs(opts.commandTimeout);
          const invokeTimeout = parseTimeoutMs(opts.invokeTimeout);

          let argv = Array.isArray(command) ? command : [];
          let rawCommand: string | undefined;
          if (raw) {
            rawCommand = raw;
            const platform = await resolveNodePlatform(opts, nodeId);
            argv = buildNodeShellCommand(rawCommand, platform ?? undefined);
          }

          const nodeEnv = env ? { ...env } : undefined;
          if (nodeEnv) {
            applyPathPrepend(nodeEnv, execDefaults?.pathPrepend, { requireExisting: true });
          }

          let approvedByAsk = false;
          let approvalDecision: "allow-once" | "allow-always" | null = null;
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
          const security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);
          const ask = maxAsk(configuredAsk, requestedAsk ?? configuredAsk);

          const approvalsSnapshot = (await callGatewayCli("exec.approvals.node.get", opts, {
            nodeId,
          })) as {
            file?: unknown;
          } | null;
          const approvalsFile =
            approvalsSnapshot && typeof approvalsSnapshot === "object"
              ? approvalsSnapshot.file
              : undefined;
          if (!approvalsFile || typeof approvalsFile !== "object") {
            throw new Error("exec approvals unavailable");
          }
          const approvals = resolveExecApprovalsFromFile({
            file: approvalsFile as ExecApprovalsFile,
            agentId,
            overrides: { security, ask },
          });
          const hostSecurity = minSecurity(security, approvals.agent.security);
          const hostAsk = maxAsk(ask, approvals.agent.ask);
          const askFallback = approvals.agent.askFallback;

          if (hostSecurity === "deny") {
            throw new Error("exec denied: host=node security=deny");
          }

          const requiresAsk = hostAsk === "always" || hostAsk === "on-miss";
          let approvalId: string | null = null;
          if (requiresAsk) {
            approvalId = crypto.randomUUID();
            const approvalTimeoutMs = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
            // The CLI transport timeout (opts.timeout) must be longer than the
            // gateway-side approval wait so the connection stays alive while the
            // user decides.  Without this override the default 35 s transport
            // timeout races — and always loses — against the 120 s approval
            // timeout, causing "gateway timeout after 35000ms" (#12098).
            const transportTimeoutMs = Math.max(
              parseTimeoutMs(opts.timeout) ?? 0,
              approvalTimeoutMs + 10_000,
            );
            const decisionResult = (await callGatewayCli(
              "exec.approval.request",
              opts,
              {
                id: approvalId,
                command: rawCommand ?? argv.join(" "),
                cwd: opts.cwd,
                host: "node",
                security: hostSecurity,
                ask: hostAsk,
                agentId,
                resolvedPath: undefined,
                sessionKey: undefined,
                timeoutMs: approvalTimeoutMs,
              },
              { transportTimeoutMs },
            )) as { decision?: string } | null;
            const decision =
              decisionResult && typeof decisionResult === "object"
                ? (decisionResult.decision ?? null)
                : null;
            if (decision === "deny") {
              throw new Error("exec denied: user denied");
            }
            if (!decision) {
              if (askFallback === "full") {
                approvedByAsk = true;
                approvalDecision = "allow-once";
              } else if (askFallback === "allowlist") {
                // defer allowlist enforcement to node host
              } else {
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
          }

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command: "system.run",
            params: {
              command: argv,
              cwd: opts.cwd,
              env: nodeEnv,
              timeoutMs,
              needsScreenRecording: opts.needsScreenRecording === true,
            },
            idempotencyKey: String(opts.idempotencyKey ?? randomIdempotencyKey()),
          };
          if (agentId) {
            (invokeParams.params as Record<string, unknown>).agentId = agentId;
          }
          if (rawCommand) {
            (invokeParams.params as Record<string, unknown>).rawCommand = rawCommand;
          }
          (invokeParams.params as Record<string, unknown>).approved = approvedByAsk;
          if (approvalDecision) {
            (invokeParams.params as Record<string, unknown>).approvalDecision = approvalDecision;
          }
          if (approvedByAsk && approvalId) {
            (invokeParams.params as Record<string, unknown>).runId = approvalId;
          }
          if (invokeTimeout !== undefined) {
            invokeParams.timeoutMs = invokeTimeout;
          }

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
