/** Node-host command dispatcher for system commands, approvals, env policy, and plugin commands. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { DEFAULT_ASK, DEFAULT_SECURITY } from "../infra/exec-approvals-config.js";
import {
  analyzeArgvCommand,
  createExecApprovalPolicySnapshot,
  ensureExecApprovalsSnapshot,
  mergeExecApprovalsSocketDefaults,
  minSecurity,
  maxAsk,
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  redactExecApprovals,
  resolveAllowAlwaysPatternCoverage,
  resolveExecApprovalsFromFile,
  updateExecApprovals,
  type ExecAsk,
  type ExecApprovalsFile,
  type ExecApprovalsResolved,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { planShellAuthorization } from "../infra/exec-authorization-plan.js";
import {
  requestExecHostViaSocket,
  type ExecHostRequest,
  type ExecHostResponse,
} from "../infra/exec-host.js";
import { extractShellWrapperCommand } from "../infra/exec-wrapper-resolution.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_DEVICE_APPS_COMMAND,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
} from "../infra/node-commands.js";
import { logWarn } from "../logger.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import {
  createNodeInvokeResponder,
  type NodeHostClient,
  type NodeInvokeResponder,
} from "./client.js";
import { invokeNodeWorkerComputerCommand, type NodeWorkerComputer } from "./computer-command.js";
import { invokeNodeDesktopStream } from "./desktop-stream-command.js";
import {
  handleClaudeCliNodeInvoke,
  type NodeHostInvokeRuntime,
} from "./invoke-agent-cli-claude-handler.js";
import { invokeDeviceApps } from "./invoke-device-apps.js";
import { invokeNodeFileCommand } from "./invoke-file-commands.js";
import { boundMcpToolResultPayload } from "./invoke-mcp-result.js";
import { withNodeHostPluginInvocation } from "./invoke-plugin-context.js";
import { runCommand } from "./invoke-run-command.js";
import { buildSystemRunPrepareCoverageEnv } from "./invoke-system-run-plan.js";
import {
  buildSystemRunApprovalPlan,
  handleSystemRunInvoke,
  resolveEffectiveSystemRunExecPolicy,
} from "./invoke-system-run.js";
import type {
  ExecEventPayload,
  ExecFinishedEventParams,
  NodeInvokeRequestPayload,
  SkillBinsProvider,
  SystemRunParams,
} from "./invoke-types.js";
import { NodeHostMcpError, type NodeHostMcpManager } from "./mcp.js";
import { buildNodeEventParams } from "./node-event-params.js";
import type { NodeWorkerBundleInstallerControl } from "./node-worker-bundle-installer.js";
import { invokeNodeWorkerSupervisorCommand } from "./node-worker-supervisor-commands.js";
import type { NodeWorkerSupervisorControl } from "./node-worker-supervisor-contract.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";
import { invokeRegisteredNodeHostCommand as invokePlugin } from "./plugin-node-host.js";
import { resolveNodeHostedSkillDirectory } from "./skills.js";

const MCP_ERROR_MESSAGE_MAX_CHARS = 1_024;

const OUTPUT_EVENT_TAIL = 20_000;
const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type NodeHostPrivateInvokeRuntime = NodeHostInvokeRuntime & {
  canReportAbortedFailure?: (error: unknown) => boolean;
  flushPluginCommandIo?: () => Promise<void>;
  workerBundleInstaller?: NodeWorkerBundleInstallerControl;
  workerSupervisor?: NodeWorkerSupervisorControl;
  workerWorkspace?: NodeWorkerWorkspaceRuntime;
  workerComputer?: NodeWorkerComputer;
};

const execHostEnforced =
  normalizeLowercaseStringOrEmpty(process.env.OPENCLAW_NODE_EXEC_HOST ?? "") === "app";
const execHostFallbackAllowed =
  normalizeLowercaseStringOrEmpty(process.env.OPENCLAW_NODE_EXEC_FALLBACK ?? "") !== "0";
const preferMacAppExecHost = process.platform === "darwin" && execHostEnforced;

type SystemWhichParams = {
  bins: string[];
};

type McpToolsCallParams = {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
};

type SystemExecApprovalsSetParams = {
  file: ExecApprovalsFile;
  baseHash?: string | null;
};

type SystemRunPrepareParams = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  env?: Record<string, string> | null;
  agentId?: unknown;
  sessionKey?: unknown;
  strictInlineEval?: unknown;
};

function resolveNodeSkillCwdParam<T extends { cwd?: unknown }>(params: T, nodeId: string): T {
  if (typeof params.cwd !== "string") {
    return params;
  }
  // Resolve before approval planning so the plan, policy, and spawn all bind
  // the same canonical node-local directory instead of trusting a URI at exec time.
  const resolved = resolveNodeHostedSkillDirectory(params.cwd, nodeId);
  return resolved ? { ...params, cwd: resolved } : params;
}

async function buildSystemRunAllowAlwaysCoverage(params: {
  argv: string[];
  rawCommand?: string | null;
  cwd: string | null | undefined;
  env: Record<string, string> | undefined;
  strictInlineEval?: boolean;
}) {
  const cwd = params.cwd ?? undefined;
  const shellWrapper = extractShellWrapperCommand(params.argv, params.rawCommand);
  if (shellWrapper.isWrapper) {
    if (!shellWrapper.command) {
      return { complete: false, patterns: [] };
    }
    const authorizationPlan = await planShellAuthorization({
      command: shellWrapper.command,
      cwd,
      env: params.env,
      platform: process.platform,
    });
    if (!authorizationPlan.ok) {
      return { complete: false, patterns: [] };
    }
    const candidates = authorizationPlan.groups.flatMap((group) => group.candidates);
    const reusableSegments = candidates
      .filter((candidate) => candidate.allowAlways)
      .map((candidate) => candidate.sourceSegment);
    const coverage = resolveAllowAlwaysPatternCoverage({
      segments: reusableSegments,
      cwd,
      env: params.env,
      platform: process.platform,
      strictInlineEval: params.strictInlineEval,
    });
    return {
      ...coverage,
      complete: coverage.complete && reusableSegments.length === candidates.length,
    };
  }
  const analysis = analyzeArgvCommand({ argv: params.argv, cwd, env: params.env });
  if (!analysis.ok) {
    return { complete: false, patterns: [] };
  }
  return resolveAllowAlwaysPatternCoverage({
    segments: analysis.segments,
    cwd,
    env: params.env,
    platform: process.platform,
    strictInlineEval: params.strictInlineEval,
  });
}

type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

export type { NodeInvokeRequestPayload, SkillBinsProvider } from "./invoke-types.js";

function resolveExecSecurity(value?: string): ExecSecurity {
  return value === "deny" || value === "allowlist" || value === "full" ? value : DEFAULT_SECURITY;
}

function isCmdExeInvocation(argv: string[]): boolean {
  const token = argv[0]?.trim();
  if (!token) {
    return false;
  }
  const base = normalizeLowercaseStringOrEmpty(path.win32.basename(token));
  return base === "cmd.exe" || base === "cmd";
}

function resolveExecAsk(value?: string): ExecAsk {
  return value === "off" || value === "on-miss" || value === "always" ? value : DEFAULT_ASK;
}

/** Builds a sanitized execution environment with controlled PATH and approved overrides. */
function sanitizeEnv(overrides?: Record<string, string> | null): Record<string, string> {
  return sanitizeHostExecEnv({ overrides, blockPathOverrides: true });
}

function truncateOutput(raw: string, maxChars: number): { text: string; truncated: boolean } {
  if (raw.length <= maxChars) {
    return { text: raw, truncated: false };
  }
  return { text: `... (truncated) ${sliceUtf16Safe(raw, raw.length - maxChars)}`, truncated: true };
}

function requireExecApprovalsBaseHash(
  params: SystemExecApprovalsSetParams,
  snapshot: ExecApprovalsSnapshot,
) {
  const baseHash = typeof params.baseHash === "string" ? params.baseHash.trim() : "";
  if (!snapshot.exists) {
    if (baseHash && baseHash !== snapshot.hash) {
      throw new Error("INVALID_REQUEST: exec approvals changed; reload and retry");
    }
    return;
  }
  if (!snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash unavailable; reload and retry");
  }
  if (!baseHash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash required; reload and retry");
  }
  if (baseHash !== snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals changed; reload and retry");
  }
}

function resolveEnvPath(env?: Record<string, string>): string[] {
  const raw =
    env?.PATH ??
    (env as Record<string, string>)?.Path ??
    process.env.PATH ??
    process.env.Path ??
    DEFAULT_NODE_PATH;
  return raw.split(path.delimiter).filter(Boolean);
}

function resolveExecutable(bin: string, env?: Record<string, string>) {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  const extensions =
    process.platform === "win32"
      ? (
          env?.PATHEXT ??
          env?.PathExt ??
          env?.Pathext ??
          process.env.PATHEXT ??
          process.env.PathExt ??
          ".EXE;.CMD;.BAT;.COM"
        )
          .split(";")
          .map((ext) => normalizeLowercaseStringOrEmpty(ext))
      : [""];
  for (const dir of resolveEnvPath(env)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function handleSystemWhich(params: SystemWhichParams, env?: Record<string, string>) {
  const bins = normalizeStringEntries(params.bins);
  const found: Record<string, string> = {};
  for (const bin of bins) {
    const pathLocal = resolveExecutable(bin, env);
    if (pathLocal) {
      found[bin] = pathLocal;
    }
  }
  return { bins: found };
}

function buildExecEventPayload(payload: ExecEventPayload): ExecEventPayload {
  if (!payload.output) {
    return payload;
  }
  const trimmed = payload.output.trim();
  if (!trimmed) {
    return payload;
  }
  const { text } = truncateOutput(trimmed, OUTPUT_EVENT_TAIL);
  return { ...payload, output: text };
}

async function sendExecFinishedEvent(
  params: ExecFinishedEventParams & {
    client: NodeHostClient;
  },
) {
  const combined = [params.result.stdout, params.result.stderr, params.result.error]
    .filter(Boolean)
    .join("\n");
  await sendNodeEvent(
    params.client,
    "exec.finished",
    buildExecEventPayload({
      sessionKey: params.sessionKey,
      runId: params.runId,
      host: "node",
      command: params.commandText,
      exitCode: params.result.exitCode ?? undefined,
      timedOut: params.result.timedOut,
      success: params.result.success,
      output: combined,
      suppressNotifyOnExit: params.suppressNotifyOnExit,
    }),
  );
}

async function runViaMacAppExecHost(params: {
  approvals: ExecApprovalsResolved;
  request: ExecHostRequest;
  signal?: AbortSignal;
}): Promise<ExecHostResponse | null> {
  const { approvals, request } = params;
  return await requestExecHostViaSocket({
    socketPath: approvals.socketPath,
    token: approvals.token,
    request,
    signal: params.signal,
  });
}

function classifyExecApprovalsStorageError(err: unknown): "TIMEOUT" | "UNAVAILABLE" {
  const errorCode = err && typeof err === "object" && "code" in err ? err.code : null;
  return errorCode === "file_lock_timeout" ? "TIMEOUT" : "UNAVAILABLE";
}

function createNodeHostInvocationClient(
  client: NodeHostClient,
  signal: AbortSignal | undefined,
): NodeHostClient {
  if (!signal) {
    return client;
  }
  return {
    async request<T = Record<string, unknown>>(
      method: string,
      params?: unknown,
      opts?: Parameters<NodeHostClient["request"]>[2],
    ): Promise<T> {
      // Superseded invocations share their replacement's Gateway id, so late
      // results, progress, and events must not outlive invocation ownership.
      if (
        signal.aborted &&
        (method === "node.invoke.result" ||
          method === "node.invoke.progress" ||
          method === "node.event")
      ) {
        return {} as T;
      }
      return opts === undefined
        ? await client.request<T>(method, params)
        : await client.request<T>(method, params, opts);
    },
  };
}

/** Handles one node-host command invocation payload and returns serialized results. */
export async function handleInvoke(
  frame: NodeInvokeRequestPayload,
  client: NodeHostClient,
  skillBins: SkillBinsProvider,
  mcpManager?: NodeHostMcpManager,
  runtime: NodeHostPrivateInvokeRuntime = {},
) {
  const invocationClient = createNodeHostInvocationClient(client, runtime.signal);
  try {
    await dispatchInvoke(frame, invocationClient, client, skillBins, mcpManager, runtime);
  } catch (err) {
    // Gateway events launch this handler without awaiting it. Consume unexpected
    // failures here so one bad request cannot terminate the node-host process.
    logWarn(
      `node host invoke failed (command=${frame.command ?? "unknown"}, id=${frame.id}): ${String(err)}`,
    );
    try {
      await createNodeInvokeResponder(invocationClient, frame).error(
        "UNAVAILABLE",
        "node invocation failed",
      );
    } catch (sendErr) {
      // The caller intentionally detaches this promise. A failed result send is
      // terminal for this request and must not surface as an unhandled rejection.
      logWarn(
        `node host invoke failure response could not be sent (id=${frame.id}): ${String(sendErr)}`,
      );
    }
  }
}

async function dispatchInvoke(
  frame: NodeInvokeRequestPayload,
  client: NodeHostClient,
  abortedFailureClient: NodeHostClient,
  skillBins: SkillBinsProvider,
  mcpManager?: NodeHostMcpManager,
  runtime: NodeHostPrivateInvokeRuntime = {},
) {
  const command = frame.command ?? "";
  const response = createNodeInvokeResponder(client, frame);
  if (
    (command === NODE_WORKER_DESKTOP_COMPUTER_COMMAND && !runtime.workerComputer) ||
    (runtime.workerComputer && (command === "screen.snapshot" || command === "computer.act"))
  ) {
    await response.error("UNAVAILABLE", "computer command is unavailable on this node transport");
    return;
  }
  const workerSupervisorResult = await invokeNodeWorkerSupervisorCommand({
    command,
    paramsJSON: frame.paramsJSON,
    bundleInstaller: runtime.workerBundleInstaller,
    supervisor: runtime.workerSupervisor,
    workspace: runtime.workerWorkspace,
    gatewayUrl: runtime.gatewayUrl,
    gatewayTlsFingerprint: runtime.gatewayTlsFingerprint,
    gatewayCloudflareAccess: runtime.gatewayCloudflareAccess,
    signal: runtime.signal,
  });
  if (workerSupervisorResult.handled) {
    if (workerSupervisorResult.ok) {
      await response.json(workerSupervisorResult.payload);
    } else {
      await response.error(workerSupervisorResult.code, workerSupervisorResult.message);
    }
    return;
  }
  if (command === NODE_DEVICE_APPS_COMMAND) {
    const result = await invokeDeviceApps({
      paramsJSON: frame.paramsJSON,
      sharingEnabled: runtime.installedAppsSharingEnabled === true,
      ...(runtime.installedAppsPlatform ? { platform: runtime.installedAppsPlatform } : {}),
      ...(runtime.scanInstalledApps ? { scan: runtime.scanInstalledApps } : {}),
    });
    if (result.ok) {
      await response.json(result.payload);
    } else {
      await response.error(result.code, result.message);
    }
    return;
  }
  if (command === NODE_DESKTOP_STREAM_COMMAND) {
    try {
      await invokeNodeDesktopStream({
        paramsJSON: frame.paramsJSON,
        gatewayUrl: runtime.gatewayUrl,
        gatewayTlsFingerprint: runtime.gatewayTlsFingerprint,
        gatewayCloudflareAccess: runtime.gatewayCloudflareAccess,
        config: runtime.desktopHostConfig,
        signal: runtime.signal,
        emitStatus: runtime.emitProgress,
      });
      await response.json({ status: "closed" });
    } catch (error) {
      await response.error(
        "UNAVAILABLE",
        error instanceof Error ? error.message : "desktop stream unavailable",
      );
    }
    return;
  }
  if (command === "system.execApprovals.get") {
    let includeResolvedDefaults = false;
    try {
      if (frame.paramsJSON != null) {
        const params = decodeParams<unknown>(frame.paramsJSON);
        if (
          !isRecord(params) ||
          (params.includeResolvedDefaults !== undefined &&
            typeof params.includeResolvedDefaults !== "boolean")
        ) {
          throw new Error("INVALID_REQUEST: includeResolvedDefaults must be boolean");
        }
        includeResolvedDefaults = params.includeResolvedDefaults === true;
      }
    } catch (err) {
      await response.invalid(err);
      return;
    }
    try {
      const snapshot = await ensureExecApprovalsSnapshot();
      const payload = {
        ...redactExecApprovals(snapshot),
        ...(includeResolvedDefaults
          ? { resolvedDefaults: resolveExecApprovalsFromFile({ file: snapshot.file }).defaults }
          : {}),
      };
      await response.json(payload);
    } catch (err) {
      await response.error(classifyExecApprovalsStorageError(err), String(err));
    }
    return;
  }

  if (command === "system.execApprovals.set") {
    let params: SystemExecApprovalsSetParams;
    let normalized: ExecApprovalsFile;
    try {
      params = decodeParams<SystemExecApprovalsSetParams>(frame.paramsJSON);
      if (!params.file || typeof params.file !== "object") {
        throw new Error("INVALID_REQUEST: exec approvals file required");
      }
      normalized = normalizeExecApprovals(params.file);
    } catch (err) {
      await response.invalid(err);
      return;
    }

    let snapshot: ExecApprovalsSnapshot;
    try {
      // A stale save must not initialize state before its base hash is checked.
      snapshot = readExecApprovalsSnapshot();
    } catch (err) {
      await response.error(classifyExecApprovalsStorageError(err), String(err));
      return;
    }

    try {
      requireExecApprovalsBaseHash(params, snapshot);
    } catch (err) {
      await response.invalid(err);
      return;
    }

    let nextSnapshot: ExecApprovalsSnapshot | null;
    try {
      nextSnapshot = await updateExecApprovals({
        baseHash: snapshot.hash,
        update: (current) => mergeExecApprovalsSocketDefaults({ normalized, current }),
      });
    } catch (err) {
      await response.error(classifyExecApprovalsStorageError(err), String(err));
      return;
    }

    if (!nextSnapshot) {
      await response.error(
        "INVALID_REQUEST",
        "INVALID_REQUEST: exec approvals changed; reload and retry",
      );
      return;
    }

    const payload: ExecApprovalsSnapshot = redactExecApprovals(nextSnapshot);
    await response.json(payload);
    return;
  }

  if (command === "system.which") {
    try {
      const params = decodeParams<SystemWhichParams>(frame.paramsJSON);
      if (!Array.isArray(params.bins)) {
        throw new Error("INVALID_REQUEST: bins required");
      }
      const env = sanitizeEnv(undefined);
      const payload = await handleSystemWhich(params, env);
      await response.json(payload);
    } catch (err) {
      await response.invalid(err);
    }
    return;
  }

  const fileCommand = await invokeNodeFileCommand(command, frame.paramsJSON);
  if (fileCommand) {
    if ("error" in fileCommand) {
      await response.invalid(fileCommand.error);
    } else {
      await response.json(fileCommand.payload);
    }
    return;
  }

  if (command === NODE_MCP_TOOLS_CALL_COMMAND) {
    await handleMcpToolsCall(frame, response, mcpManager, runtime.signal);
    return;
  }

  if (command === NODE_AGENT_CLI_CLAUDE_RUN_COMMAND) {
    await handleClaudeCliNodeInvoke({
      frame,
      client,
      response,
      skillBins,
      runtime,
      deps: {
        resolveExecSecurity,
        resolveExecAsk,
        isCmdExeInvocation,
        sanitizeEnv,
        runViaMacAppExecHost,
        buildExecEventPayload,
      },
    });
    return;
  }
  try {
    const { pluginCommandIo: io, pluginCommandContext: context } = runtime;
    const pluginResult = await withNodeHostPluginInvocation(
      { context, sessionKey: frame.sessionKey, signal: runtime.signal },
      async (invokeContext) =>
        command === NODE_WORKER_DESKTOP_COMPUTER_COMMAND
          ? await invokeNodeWorkerComputerCommand({
              paramsJSON: frame.paramsJSON,
              computer: runtime.workerComputer!,
              invoke: (innerCommand, paramsJSON) =>
                invokePlugin(innerCommand, paramsJSON, undefined, invokeContext),
            })
          : await invokePlugin(command, frame.paramsJSON, io, invokeContext),
    );
    if (pluginResult !== null) {
      await runtime.flushPluginCommandIo?.();
      await response.send({ ok: true, payloadJSON: pluginResult });
      return;
    }
  } catch (err) {
    // Only the exact current owner's exact framed failure may bypass its aborted-client fence.
    const failureResponse = runtime.canReportAbortedFailure?.(err)
      ? createNodeInvokeResponder(abortedFailureClient, frame)
      : response;
    await failureResponse.invalid(err);
    return;
  }

  if (command === "system.run.prepare") {
    try {
      const params = resolveNodeSkillCwdParam(
        decodeParams<SystemRunPrepareParams>(frame.paramsJSON),
        frame.nodeId,
      );
      const { getRuntimeConfig } = await import("../config/config.js");
      const execPolicy = await resolveEffectiveSystemRunExecPolicy({
        cfg: getRuntimeConfig(),
        agentId: normalizeOptionalString(params.agentId),
        defaultSecurity: resolveExecSecurity(undefined),
        defaultAsk: resolveExecAsk(undefined),
        requireSocket: preferMacAppExecHost,
      });
      // Omitted caller policy retains the approval-preparation contract. A caller can
      // narrow local policy, but cannot turn a restrictive node into an ordinary launch.
      const bindApproval =
        params.security === undefined ||
        params.ask === undefined ||
        minSecurity(execPolicy.security, resolveExecSecurity(params.security)) !== "full" ||
        maxAsk(execPolicy.ask, resolveExecAsk(params.ask)) !== "off" ||
        params.strictInlineEval === true ||
        execPolicy.agentExec?.strictInlineEval === true ||
        execPolicy.globalExec?.strictInlineEval === true;
      const prepared = buildSystemRunApprovalPlan(params, bindApproval);
      if (!prepared.ok) {
        await response.error(
          "INVALID_REQUEST",
          prepared.reason === "unsupported-command-shape"
            ? `${prepared.message}\nNo approval request was created for this attempt; this is not a user denial. Retry a supported single executable with an absolute path through the normal approval flow. This node approval path cannot bind script/interpreter payloads nested in its shell wrapper.`
            : prepared.message,
        );
        return;
      }
      const prepareEnv = buildSystemRunPrepareCoverageEnv({
        argv: prepared.plan.argv,
        env: params.env ?? undefined,
      });
      if (!prepareEnv.ok) {
        await response.error("INVALID_REQUEST", prepareEnv.message);
        return;
      }
      const plan = {
        ...prepared.plan,
        policySnapshot: createExecApprovalPolicySnapshot({
          file: execPolicy.approvals.file,
          agentId: prepared.plan.agentId ?? undefined,
        }),
      };
      await response.json({
        plan,
        execPolicy: {
          security: execPolicy.security,
          ask: execPolicy.ask,
        },
        allowAlwaysCoverage: bindApproval
          ? await buildSystemRunAllowAlwaysCoverage({
              argv: prepared.plan.argv,
              rawCommand: typeof params.rawCommand === "string" ? params.rawCommand : null,
              cwd: prepared.plan.cwd,
              env: prepareEnv.env,
              strictInlineEval: params.strictInlineEval === true,
            })
          : { complete: false, patterns: [] },
      });
    } catch (err) {
      await response.invalid(err);
    }
    return;
  }

  if (command !== "system.run") {
    await response.error("UNAVAILABLE", "command not supported");
    return;
  }

  let params: SystemRunParams;
  try {
    params = resolveNodeSkillCwdParam(
      decodeParams<SystemRunParams>(frame.paramsJSON),
      frame.nodeId,
    );
  } catch (err) {
    await response.invalid(err);
    return;
  }

  if (!Array.isArray(params.command) || params.command.length === 0) {
    await response.error("INVALID_REQUEST", "command required");
    return;
  }

  await handleSystemRunInvoke({
    client,
    params,
    skillBins,
    signal: runtime.signal,
    execHostEnforced,
    execHostFallbackAllowed,
    resolveExecSecurity,
    resolveExecAsk,
    isCmdExeInvocation,
    sanitizeEnv,
    runCommand,
    runViaMacAppExecHost,
    sendNodeEvent,
    buildExecEventPayload,
    sendInvokeResult: response.send,
    sendExecFinishedEvent: async (event) => {
      await sendExecFinishedEvent({ ...event, client });
    },
    preferMacAppExecHost,
  });
}

function decodeMcpToolsCallParams(raw?: string | null): McpToolsCallParams {
  const value = decodeParams<unknown>(raw);
  if (!isRecord(value)) {
    throw new Error("INVALID_REQUEST: MCP tool params must be an object");
  }
  const server = typeof value.server === "string" ? value.server.trim() : "";
  const tool = typeof value.tool === "string" ? value.tool.trim() : "";
  if (!server || !tool) {
    throw new Error("INVALID_REQUEST: server and tool required");
  }
  if (value.arguments !== undefined && !isRecord(value.arguments)) {
    throw new Error("INVALID_REQUEST: arguments must be an object");
  }
  return {
    server,
    tool,
    ...(value.arguments ? { arguments: value.arguments } : {}),
  };
}

async function handleMcpToolsCall(
  frame: NodeInvokeRequestPayload,
  response: NodeInvokeResponder,
  mcpManager: NodeHostMcpManager | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!mcpManager) {
    await response.error("MCP_SERVER_UNAVAILABLE", "node host MCP is unavailable");
    return;
  }
  let params: McpToolsCallParams;
  try {
    params = decodeMcpToolsCallParams(frame.paramsJSON);
  } catch (error) {
    await response.invalid(error);
    return;
  }
  try {
    const result = await mcpManager.callMcpTool({
      ...params,
      timeoutMs: frame.timeoutMs ?? undefined,
      ...(signal ? { signal } : {}),
    });
    await response.send({ ok: true, payload: boundMcpToolResultPayload(result) });
  } catch (error) {
    if (error instanceof NodeHostMcpError) {
      await response.error(error.code, error.message);
      return;
    }
    await response.error(
      "MCP_TOOL_ERROR",
      truncateUtf16Safe(String(error), MCP_ERROR_MESSAGE_MAX_CHARS),
    );
  }
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- CLI JSON params are typed by the invoked method.
function decodeParams<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("INVALID_REQUEST: paramsJSON malformed JSON");
  }
}

async function sendNodeEvent(client: NodeHostClient, event: string, payload: unknown) {
  try {
    await client.request("node.event", buildNodeEventParams(event, payload));
  } catch {
    // ignore: node events are best-effort
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
