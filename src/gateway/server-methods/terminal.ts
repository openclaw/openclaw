import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
// Operator terminal gateway methods: open a PTY shell bound to the caller's
// connection, then stream input/resize/close over the same WebSocket. All
// methods require admin scope (enforced by the descriptor table); this module
// re-checks that the feature is enabled and that isolation permits a host shell.
import {
  ErrorCodes,
  errorShape,
  type TerminalUploadResult,
  validateTerminalAttachParams,
  validateTerminalCloseParams,
  validateTerminalInputParams,
  validateTerminalOpenParams,
  validateTerminalResizeParams,
  validateTerminalUploadResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { allowsProcessHomeSessionScan } from "../../config/paths.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import { NODE_TERMINAL_UPLOAD_COMMAND } from "../../infra/node-commands.js";
import { mergeProcessEnv } from "../../infra/process-env.js";
import type { TerminalUploadFile } from "../../infra/terminal-file-upload.js";
import type { SessionCatalogTerminalPlan } from "../../plugins/session-catalog.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { applyPluginNodeInvokePolicy } from "../node-invoke-plugin-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import type { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { buildTerminalEnv, type TerminalLaunchResolution } from "../terminal/launch.js";
import { createNodeRelayBackend } from "../terminal/node-relay.js";
import {
  createTerminalOpenDeadline,
  TerminalOpenDeadlineError,
  waitForTerminalOpenDeadline,
} from "../terminal/open-deadline.js";
import type { AgentTerminalOwner } from "../terminal/session-manager.types.js";
import { resolveSessionCatalogProvider } from "./session-catalog.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import {
  authorizeTerminalNodeCommand,
  resolveTerminalOpenSpawnPlan,
} from "./terminal-open-plan.js";
import { terminalUploadHandlers } from "./terminal-upload.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

function invalid(respond: GatewayRequestHandlerOptions["respond"], detail: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, detail));
}

function requireConnId(opts: GatewayRequestHandlerOptions): string | null {
  const connId = opts.client?.connId;
  if (!connId) {
    invalid(opts.respond, "terminal requires an authenticated connection");
    return null;
  }
  return connId;
}

export { TERMINAL_OPEN_DEADLINE_MS } from "../terminal/open-deadline.js";

function terminalFailureMessage(message: string, hint?: string): string {
  return hint ? `${message}; ${hint}` : message;
}

function respondTerminalUnavailable(
  respond: GatewayRequestHandlerOptions["respond"],
  message: string,
  hint?: string,
): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, terminalFailureMessage(message, hint)),
  );
}

async function stageNodeTerminalUpload(
  context: GatewayRequestHandlerOptions["context"],
  nodeId: string,
  file: TerminalUploadFile,
): Promise<TerminalUploadResult> {
  file.assertCommitAllowed?.();
  const access = authorizeTerminalNodeCommand(context, nodeId, NODE_TERMINAL_UPLOAD_COMMAND);
  if (!access.ok) {
    throw new Error(access.message);
  }
  const result = await context.nodeRegistry.invoke({
    nodeId,
    expectedConnId: access.node.connId,
    ...(access.node.pairingGeneration
      ? { expectedPairingGeneration: access.node.pairingGeneration }
      : {}),
    command: NODE_TERMINAL_UPLOAD_COMMAND,
    params: { name: file.name, contentBase64: file.contentBase64 },
    isDispatchAuthorized: () => {
      file.assertCommitAllowed?.();
      return true;
    },
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    throw new Error(result.error?.message ?? "terminal node upload failed");
  }
  const payload = result.payloadJSON ? safeParseJson(result.payloadJSON) : result.payload;
  if (!validateTerminalUploadResult(payload)) {
    throw new Error("terminal node returned an invalid upload result");
  }
  // Insertion policy belongs to the admitted catalog plan, not the node reply.
  return { path: payload.path, size: payload.size };
}

function respondLaunchBlocked(
  respond: GatewayRequestHandlerOptions["respond"],
  block: Extract<TerminalLaunchResolution, { ok: false }>["block"],
  hint?: string,
): void {
  if (block.kind === "disabled") {
    respondTerminalUnavailable(respond, "terminal is disabled", hint);
    return;
  }
  // Fail closed: a sandboxed agent must never receive a host shell.
  const message =
    block.kind === "unknown-agent"
      ? `unknown agent "${block.agentId}"`
      : block.kind === "owner-required"
        ? block.message
        : `terminal unavailable: agent "${block.agentId}" runs in a sandbox (mode "${block.mode}"); in-sandbox terminals are not supported yet`;
  invalid(respond, terminalFailureMessage(message, hint));
}

// A start RPC has no emulator dimensions yet. Match the Control UI's existing
// fallback grid; terminal.resize replaces it once the new tab is mounted.
export const CATALOG_TERMINAL_INITIAL_SIZE = { cols: 80, rows: 24 } as const;

type TerminalSessionOpenRequest = {
  agentId?: string;
  sessionKey?: string;
  cols: number;
  rows: number;
  requiredCwd?: string;
  requireCliAgents?: boolean;
  resolveCatalogPlan?: (agentId: string) => Promise<SessionCatalogTerminalPlan>;
  catalogFailureMessage?: string;
  failureHint?: string;
};

/** Canonical terminal admission and launch path shared by shell, resume, and start RPCs. */
export async function openTerminalSession(
  opts: GatewayRequestHandlerOptions,
  request: TerminalSessionOpenRequest,
): Promise<void> {
  const binding = request.sessionKey
    ? captureIncognitoSessionSource({ agentId: request.agentId, sessionKey: request.sessionKey })
    : undefined;
  if (binding && request.sessionKey) {
    const authority = readGatewayRequestMutationAuthority(opts);
    const sessionKey = request.sessionKey;
    if ("kind" in binding) {
      return openTerminalSessionWithSource(opts, request, {
        entry: undefined,
        assertCurrent() {
          authority.assertCurrent();
          binding.assertCurrent();
        },
      });
    }
    const claim = binding.actor.sessions.captureCurrent(sessionKey);
    return binding.actor.sessions.withSharedState(async () => {
      const read = await binding.actor.sessions.read(
        authority,
        { sessionKey },
        binding.admissionSignal,
      );
      const assertCurrent = () => {
        authority.assertCurrent();
        binding.admissionSignal?.throwIfAborted();
        binding.actor.assertReadable();
        claim.assertCurrent();
        const error = resolveSessionWorkStartError(
          sessionKey,
          binding.actor.sessions.readSharing(sessionKey)?.entry,
          {
            expectedSessionId: read.entry?.sessionId,
          },
        );
        if (error) {
          throw new Error(error);
        }
      };
      read.snapshot.assertCurrent();
      return openTerminalSessionWithSource(opts, request, { entry: read.entry, assertCurrent });
    });
  }
  return openTerminalSessionWithSource(opts, request);
}

async function openTerminalSessionWithSource(
  opts: GatewayRequestHandlerOptions,
  request: TerminalSessionOpenRequest,
  source?: {
    entry: ReturnType<typeof loadGatewaySessionEntryReadOnly>["entry"];
    assertCurrent(): void;
  },
): Promise<void> {
  const { respond, context } = opts;
  const invalidPlan = (message: string) =>
    invalid(respond, terminalFailureMessage(message, request.failureHint));
  const unavailable = (message: string) =>
    respondTerminalUnavailable(respond, message, request.failureHint);
  const connId = requireConnId(opts);
  if (!connId) {
    return;
  }
  const manager = context.terminalSessions;
  if (!manager) {
    unavailable("terminal is not available");
    return;
  }
  let agentId = request.agentId;
  // A qualified conversation key names its terminal owner. Unqualified keys keep the
  // launch default, so a system or compatibility owner cannot pick the host shell.
  if (request.sessionKey && parseAgentSessionKey(request.sessionKey.trim())) {
    const requestedOwner = resolveRequestedSessionAgentId(
      context.getRuntimeConfig(),
      request.sessionKey,
      agentId,
    );
    if (!requestedOwner.ok) {
      respond(false, undefined, requestedOwner.error);
      return;
    }
    agentId = requestedOwner.agentId;
  }
  const launch = context.resolveTerminalLaunchPolicy(agentId);
  if (!launch.ok) {
    respondLaunchBlocked(respond, launch.block, request.failureHint);
    return;
  }
  const deadline = createTerminalOpenDeadline();

  let catalogPlan: SessionCatalogTerminalPlan | undefined;
  let title: string | undefined;
  let createBackend: (() => ReturnType<typeof createNodeRelayBackend>) | undefined;
  let nodeRelay:
    | {
        plan: Extract<SessionCatalogTerminalPlan, { kind: "node" }>;
        params: Record<string, unknown>;
        connId: string;
        pairingGeneration?: string;
      }
    | undefined;
  let stageUpload: ((file: TerminalUploadFile) => Promise<TerminalUploadResult>) | undefined;
  if (request.resolveCatalogPlan) {
    const resolveCatalogPlan = request.resolveCatalogPlan;
    try {
      catalogPlan = await waitForTerminalOpenDeadline(
        () => resolveCatalogPlan(launch.plan.agentId),
        deadline,
      );
    } catch (error) {
      if (error instanceof TerminalOpenDeadlineError) {
        unavailable("terminal open timed out");
        return;
      }
      invalidPlan(
        error instanceof Error
          ? error.message
          : (request.catalogFailureMessage ?? "catalog terminal open failed"),
      );
      return;
    }
    title = catalogPlan.title;
    if (catalogPlan.kind === "local") {
      if (catalogPlan.argv.length === 0) {
        invalidPlan("catalog terminal plan has no command");
        return;
      }
    } else {
      const nodeCatalogPlan = catalogPlan;
      if (
        nodeCatalogPlan.uploadPathStyle !== undefined &&
        nodeCatalogPlan.uploadPathStyle !== "native"
      ) {
        invalid(respond, "catalog terminal plan has an unsupported upload path style");
        return;
      }
      const uploadNodeId = nodeCatalogPlan.nodeId;
      const uploadPathStyle = nodeCatalogPlan.uploadPathStyle;
      const access = authorizeTerminalNodeCommand(
        context,
        nodeCatalogPlan.nodeId,
        nodeCatalogPlan.command,
      );
      if (!access.ok) {
        unavailable(access.message);
        return;
      }
      let nodeParams: Record<string, unknown>;
      try {
        const parsed = JSON.parse(catalogPlan.paramsJSON) as unknown;
        if (!isRecord(parsed)) {
          throw new Error("invalid params");
        }
        nodeParams = {
          ...parsed,
          cols: request.cols,
          rows: request.rows,
        };
      } catch {
        invalidPlan("catalog terminal plan has invalid params");
        return;
      }
      // Pairing promotion mutates NodeSession in place; freeze its identity before policy awaits.
      nodeRelay = {
        plan: nodeCatalogPlan,
        params: nodeParams,
        connId: access.node.connId,
        pairingGeneration: access.node.pairingGeneration,
      };
      let policyResult: Awaited<ReturnType<typeof applyPluginNodeInvokePolicy>>;
      try {
        policyResult = await waitForTerminalOpenDeadline(
          () =>
            applyPluginNodeInvokePolicy({
              context,
              client: opts.client,
              nodeSession: access.node,
              command: nodeCatalogPlan.command,
              params: nodeParams,
            }),
          deadline,
        );
      } catch (error) {
        if (error instanceof TerminalOpenDeadlineError) {
          unavailable("terminal open timed out");
          return;
        }
        throw error;
      }
      if (policyResult && !policyResult.ok) {
        unavailable(policyResult.message);
        return;
      }
      stageUpload = async (file) => ({
        ...(await stageNodeTerminalUpload(context, uploadNodeId, file)),
        ...(uploadPathStyle ? { uploadPathStyle } : {}),
      });
    }
  }

  let agentOwner: AgentTerminalOwner | undefined;
  if (request.sessionKey) {
    const runtimeConfig = context.getRuntimeConfig();
    const requestedOwner = resolveRequestedSessionAgentId(
      runtimeConfig,
      request.sessionKey,
      launch.plan.agentId,
    );
    if (!requestedOwner.ok) {
      respond(false, undefined, requestedOwner.error);
      return;
    }
    const agentSessionKey = resolveStoredSessionKeyForAgentStore({
      cfg: runtimeConfig,
      agentId: requestedOwner.agentId,
      sessionKey: request.sessionKey,
    });
    source?.assertCurrent();
    const { entry } =
      source ??
      (await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: runtimeConfig,
        key: agentSessionKey,
        agentId: requestedOwner.agentId,
      }));
    const agentSessionId = entry?.sessionId?.trim();
    if (!agentSessionId) {
      unavailable("session is no longer available; refresh and retry");
      return;
    }
    const readinessError = resolveSessionWorkStartError(agentSessionKey, entry);
    if (readinessError) {
      invalidPlan(readinessError);
      return;
    }
    agentOwner = {
      kind: "agent",
      agentSessionKey,
      agentSessionId,
      agentId: requestedOwner.agentId,
    };
  }
  if (context.isConnectionActive?.(connId) === false) {
    unavailable("terminal connection closed");
    return;
  }
  if (
    request.requireCliAgents &&
    context.getRuntimeConfig().gateway?.cliAgents?.enabled === false
  ) {
    invalid(
      respond,
      "CLI agent terminal start is disabled; enable gateway.cliAgents.enabled and retry",
    );
    return;
  }
  if (!context.isTerminalEnabled()) {
    unavailable("terminal is disabled");
    return;
  }
  const refreshedLaunch = context.resolveTerminalLaunchPolicy(agentOwner?.agentId ?? agentId);
  if (!refreshedLaunch.ok) {
    respondLaunchBlocked(respond, refreshedLaunch.block, request.failureHint);
    return;
  }
  if (nodeRelay) {
    const relay = nodeRelay;
    const access = authorizeTerminalNodeCommand(context, relay.plan.nodeId, relay.plan.command);
    if (!access.ok) {
      unavailable(access.message);
      return;
    }
    // Policy awaits cannot authorize a replacement connection or pairing.
    if (
      access.node.connId !== relay.connId ||
      access.node.pairingGeneration !== relay.pairingGeneration
    ) {
      invalid(respond, "terminal node connection changed; refresh the host and retry");
      return;
    }
    createBackend = async () =>
      await createNodeRelayBackend({
        registry: context.nodeRegistry,
        nodeId: relay.plan.nodeId,
        expectedConnId: access.node.connId,
        expectedPairingGeneration: access.node.pairingGeneration,
        // Pairing resolution can yield after admission. Fence the live authority
        // at the registry's final transport handoff, not after a CLI has started.
        isDispatchAuthorized: () => {
          source?.assertCurrent();
          return (
            context.isConnectionActive?.(connId) !== false &&
            context.isTerminalEnabled() &&
            (!request.requireCliAgents ||
              context.getRuntimeConfig().gateway?.cliAgents?.enabled !== false) &&
            context.resolveTerminalLaunchPolicy(refreshedLaunch.plan.agentId).ok &&
            authorizeTerminalNodeCommand(context, relay.plan.nodeId, relay.plan.command).ok &&
            !deadline.controller.signal.aborted &&
            Date.now() < deadline.expiresAtMs
          );
        },
        command: relay.plan.command,
        params: relay.params,
      });
  }
  const spawnPlan = resolveTerminalOpenSpawnPlan(refreshedLaunch.plan, catalogPlan);
  if (request.requiredCwd !== undefined && spawnPlan.cwd !== request.requiredCwd) {
    invalidPlan("cwd is no longer available; recreate or choose the worktree and retry");
    return;
  }
  const terminalEnv =
    catalogPlan?.kind === "local"
      ? mergeProcessEnv([
          buildTerminalEnv(process.env),
          catalogPlan.env,
          // Preserve the PATH that found a login-shell CLI so env-based shebangs
          // can resolve their interpreter inside the spawned terminal process.
          catalogPlan.pathEnv ? { PATH: catalogPlan.pathEnv } : undefined,
        ])
      : buildTerminalEnv(process.env);
  const closeOpenedSession = (sessionId: string) =>
    agentOwner ? manager.closeAgent(agentOwner, sessionId) : manager.close(connId, sessionId);
  let openingTerminal: ReturnType<typeof manager.open> | undefined;
  let outcome: Awaited<ReturnType<typeof manager.open>>;
  try {
    outcome = await waitForTerminalOpenDeadline(() => {
      source?.assertCurrent();
      openingTerminal = manager.open({
        owner: agentOwner ?? { kind: "conn", connId },
        ...(agentOwner ? { viewerConnId: connId } : {}),
        agentId: spawnPlan.agentId,
        cwd: spawnPlan.cwd,
        shell: spawnPlan.shell,
        ...(title ? { title } : {}),
        args: spawnPlan.args,
        cols: request.cols,
        rows: request.rows,
        env: terminalEnv,
        signal: deadline.controller.signal,
        ...(createBackend ? { createBackend } : {}),
        ...(stageUpload ? { stageUpload } : {}),
      });
      return openingTerminal;
    }, deadline);
  } catch (error) {
    if (error instanceof TerminalOpenDeadlineError) {
      // The backend can register immediately before deadline arbitration.
      // Close a late success by id so timeout never leaves an unreachable PTY.
      if (openingTerminal) {
        void openingTerminal.then(
          (lateOutcome) => {
            if (lateOutcome.ok) {
              closeOpenedSession(lateOutcome.sessionId);
            }
          },
          () => undefined,
        );
      }
      unavailable("terminal open timed out");
      return;
    }
    throw error;
  }
  if (!outcome.ok) {
    const code = outcome.code === "limit" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE;
    respond(
      false,
      undefined,
      errorShape(code, terminalFailureMessage(outcome.message, request.failureHint)),
    );
    return;
  }
  try {
    source?.assertCurrent();
  } catch (error) {
    closeOpenedSession(outcome.sessionId);
    throw error;
  }
  if (context.isConnectionActive?.(connId) === false) {
    // A browser deadline can close the socket while PTY creation is still
    // finishing. Release the raced session instead of leaving an orphan.
    closeOpenedSession(outcome.sessionId);
    unavailable("terminal connection closed");
    return;
  }
  context.logGateway.info(
    `terminal opened session=${outcome.sessionId} agent=${outcome.agentId} conn=${connId} shell=${outcome.shell}`,
  );
  respond(true, {
    sessionId: outcome.sessionId,
    agentId: outcome.agentId,
    shell: outcome.shell,
    cwd: outcome.cwd,
    confined: false,
    ...(title ? { title } : {}),
  });
}

function terminalSessionHandler<T extends { sessionId: string }>(
  method: "terminal.input" | "terminal.resize" | "terminal.close",
  validate: Validator<T>,
  operate: (
    manager: NonNullable<GatewayRequestHandlerOptions["context"]["terminalSessions"]>,
    connId: string,
    params: T,
  ) => boolean,
): GatewayRequestHandlers[string] {
  return async (opts) => {
    const { params, respond, context } = opts;
    if (!assertValidParams(params, validate, method, respond)) {
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    // Runtime policy flips before its restart; stop input and resize immediately.
    if (method !== "terminal.close" && !context.isTerminalEnabled()) {
      context.terminalSessions?.close(connId, params.sessionId);
      respond(true, { ok: false });
      return;
    }
    const manager = context.terminalSessions;
    const ok = (manager && operate(manager, connId, params)) ?? false;
    respond(true, { ok });
  };
}

export const terminalHandlers: GatewayRequestHandlers = {
  ...terminalUploadHandlers,
  "terminal.open": async (opts) => {
    const { params, respond } = opts;
    if (!assertValidParams(params, validateTerminalOpenParams, "terminal.open", respond)) {
      return;
    }
    let resolveCatalogPlan: ((agentId: string) => Promise<SessionCatalogTerminalPlan>) | undefined;
    if (params.catalog) {
      const provider = resolveSessionCatalogProvider(params.catalog.catalogId);
      if (!provider) {
        invalid(respond, `unknown session catalog: ${params.catalog.catalogId}`);
        return;
      }
      if (!provider.openTerminal) {
        invalid(respond, "session catalog cannot open terminals");
        return;
      }
      const openTerminal = provider.openTerminal;
      const catalog = params.catalog;
      resolveCatalogPlan = async (agentId) =>
        await openTerminal.call(provider, {
          allowProcessHomeFallback: allowsProcessHomeSessionScan(),
          agentId,
          hostId: catalog.hostId,
          threadId: catalog.threadId,
          ...(catalog.sourceHomeId ? { sourceHomeId: catalog.sourceHomeId } : {}),
        });
    }
    await openTerminalSession(opts, {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      cols: params.cols,
      rows: params.rows,
      ...(resolveCatalogPlan ? { resolveCatalogPlan } : {}),
      catalogFailureMessage: "catalog terminal open failed",
    });
  },

  "terminal.input": terminalSessionHandler(
    "terminal.input",
    validateTerminalInputParams,
    (manager, connId, params) => manager.write(connId, params.sessionId, params.data),
  ),
  "terminal.resize": terminalSessionHandler(
    "terminal.resize",
    validateTerminalResizeParams,
    (manager, connId, params) => manager.resize(connId, params.sessionId, params.cols, params.rows),
  ),
  "terminal.close": terminalSessionHandler(
    "terminal.close",
    validateTerminalCloseParams,
    (manager, connId, params) => manager.close(connId, params.sessionId),
  ),

  "terminal.attach": async (opts) => {
    const { params, respond, context } = opts;
    if (!assertValidParams(params, validateTerminalAttachParams, "terminal.attach", respond)) {
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    // Same defense-in-depth as input/resize: the disable restart may still be
    // in flight, so refuse handing a live PTY stream to a new connection.
    if (!context.terminalSessions || !context.isTerminalEnabled()) {
      respondTerminalUnavailable(respond, "terminal is not available");
      return;
    }
    const attached = context.terminalSessions.attach(connId, params.sessionId);
    if (!attached) {
      invalid(respond, `unknown terminal session "${params.sessionId}"`);
      return;
    }
    context.logGateway.info(
      `terminal attached session=${attached.sessionId} agent=${attached.agentId} conn=${connId}`,
    );
    const supportsOffsetSeq = hasGatewayClientCap(
      opts.client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.TERMINAL_OFFSET_SEQ,
    );
    // Older protocol-4 clients validate closed reply shapes from before this metadata existed.
    const supportsMetadata = hasGatewayClientCap(
      opts.client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.TERMINAL_SESSION_METADATA,
    );
    respond(true, {
      sessionId: attached.sessionId,
      agentId: attached.agentId,
      shell: attached.shell,
      ...(supportsMetadata
        ? { owner: attached.owner, ...(attached.title ? { title: attached.title } : {}) }
        : {}),
      cwd: attached.cwd,
      confined: false,
      buffer: attached.buffer,
      ...(supportsOffsetSeq ? { seq: attached.seq } : {}),
    });
  },

  "terminal.list": async (opts) => {
    const { respond, context } = opts;
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    // An empty list (not an error) when the surface is off/unwired keeps the
    // reconnect flow simple: clients just fall back to opening fresh sessions.
    const supportsMetadata = hasGatewayClientCap(
      opts.client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.TERMINAL_SESSION_METADATA,
    );
    const sessions =
      context.terminalSessions && context.isTerminalEnabled()
        ? context.terminalSessions.list().map((session) => ({
            sessionId: session.sessionId,
            agentId: session.agentId,
            shell: session.shell,
            title: supportsMetadata ? session.title : undefined,
            cwd: session.cwd,
            // Mirrors terminal.open: only unconfined host shells exist today.
            confined: false,
            attached: session.attached,
            owner: session.owner,
            createdAtMs: session.createdAtMs,
          }))
        : [];
    respond(true, { sessions });
  },
};
