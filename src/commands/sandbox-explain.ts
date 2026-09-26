import {
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
  normalizeStringifiedEntries,
} from "@openclaw/normalization-core/string-coerce";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import {
  resolveAgentConfig,
  resolveConfiguredAgentId,
  resolveSessionAgentId,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox.js";
import { getSandboxBackendWorkdirResolver } from "../agents/sandbox/backend.js";
import { buildSandboxFsMounts } from "../agents/sandbox/fs-paths.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
import { resolveSandboxToolPolicyForAgent } from "../agents/sandbox/tool-policy.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../agents/spawned-context.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  resolveAgentMainSessionKey,
  resolveSessionStorePathCore,
  type SessionEntry,
} from "../config/sessions.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { sessionDeliveryChannel } from "../utils/delivery-context.read.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

type SandboxExplainOptions = {
  session?: string;
  agent?: string;
  json: boolean;
};

const SANDBOX_DOCS_URL = "https://docs.openclaw.ai/sandbox";

function normalizeExplainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  session?: string;
}): string {
  const raw = (params.session ?? "").trim();
  if (!raw) {
    return resolveAgentMainSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
    });
  }
  if (raw.includes(":")) {
    // Fully-qualified session keys are already scoped; only short names need
    // agent/main-key expansion.
    return raw;
  }
  if (raw === "global") {
    return "global";
  }
  return buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: normalizeMainKey(raw),
  });
}

function inferProviderFromSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): string | undefined {
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed) {
    return undefined;
  }
  const [channel] = parsed.rest.trim().split(":").filter(Boolean);
  const configuredMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (!channel || channel === configuredMainKey) {
    return undefined;
  }
  // Legacy session keys embedded provider/channel in the first segment after
  // agent id; use that as a fallback when the session store lacks channel data.
  const candidate = normalizeOptionalLowercaseString(channel);
  if (!candidate) {
    return undefined;
  }
  if (candidate === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  return normalizeAnyChannelId(candidate) ?? undefined;
}

function resolveActiveChannel(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  sessionKey: string;
}): string | undefined {
  const normalizedCandidate = normalizeOptionalLowercaseString(
    sessionDeliveryChannel(params.entry),
  );
  if (normalizedCandidate === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  return normalizeAnyChannelId(normalizedCandidate) ?? inferProviderFromSessionKey(params);
}

export async function sandboxExplainCommand(
  opts: SandboxExplainOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = getRuntimeConfig();

  const requestedSession = opts.session?.trim();
  const requestedAgent = opts.agent?.trim();
  if (opts.agent !== undefined && !requestedAgent) {
    throw new Error("--agent must not be blank");
  }
  const requestedAgentId = requestedAgent ? normalizeAgentId(requestedAgent) : undefined;
  const sessionAgentId =
    requestedSession && requestedSession !== "global" && requestedSession.includes(":")
      ? normalizeAgentId(resolveAgentIdFromSessionKey(requestedSession))
      : undefined;
  if (requestedAgentId && sessionAgentId && requestedAgentId !== sessionAgentId) {
    throw new Error(
      `Sandbox explain agent "${requestedAgentId}" does not match session agent "${sessionAgentId}".`,
    );
  }
  if (requestedAgentId) {
    resolveConfiguredAgentId(cfg, requestedAgentId);
  }
  const resolvedAgentId = resolveSessionAgentId({
    sessionKey: requestedSession,
    config: cfg,
    agentId: requestedAgentId,
  });

  const sessionKey = normalizeExplainSessionKey({
    cfg,
    agentId: resolvedAgentId,
    session: opts.session,
  });

  const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, resolvedAgentId);
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey,
    agentId: resolvedAgentId,
    classificationAgentId: resolvedAgentId,
  });
  const configuredSandbox = resolveSandboxConfigForAgent(cfg, resolvedAgentId);
  const sandboxCfg = sandboxRuntime.sandboxRequired
    ? {
        ...configuredSandbox,
        scope: "agent" as const,
        workspaceAccess: sandboxRuntime.workspaceAccess,
      }
    : configuredSandbox;
  const mainSessionKey = sandboxRuntime.mainSessionKey;
  const sessionIsSandboxed = sandboxRuntime.sandboxed;
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: resolvedAgentId,
  });
  // CLI reads must not join the Gateway's writable SQLite lifecycle (#101290).
  const sessionEntry = loadSessionEntryReadOnly({
    agentId: resolvedAgentId,
    sessionKey,
    storePath,
  });

  const agentConfig = resolveAgentConfig(cfg, resolvedAgentId);
  // Spawned sessions persist their inherited workspace and direct-mode cwd so
  // later turns keep running in the same location. Explain must mirror those
  // overrides or its effective paths point at a different runtime.
  const configuredWorkspaceDir = resolveAgentWorkspaceDir(cfg, resolvedAgentId);
  const sessionWorkspaceDir = resolveIngressWorkspaceOverrideForSessionRun({
    spawnedBy: sessionEntry?.spawnedBy,
    workspaceDir: sessionEntry?.spawnedWorkspaceDir,
    cwd: sessionEntry?.spawnedCwd,
  });
  const effectiveAgentWorkspaceDir = sessionWorkspaceDir ?? configuredWorkspaceDir;
  const directRuntimeCwd =
    normalizeOptionalString(sessionEntry?.spawnedCwd) ?? effectiveAgentWorkspaceDir;
  const workspaceLayout = resolveSandboxWorkspaceLayoutPaths({
    cfg: sandboxCfg,
    agentId: resolvedAgentId,
    isolationSubject: sandboxRuntime.isolationSubject,
    rawSessionKey:
      sessionKey === "global"
        ? buildAgentMainSessionKey({
            agentId: resolvedAgentId,
            mainKey: normalizeMainKey(cfg.session?.mainKey),
          })
        : sessionKey,
    workspaceDir: effectiveAgentWorkspaceDir,
  });
  const sandboxWorkdir = getSandboxBackendWorkdirResolver(sandboxCfg.backend)?.({
    sessionKey,
    scopeKey: workspaceLayout.scopeKey,
    workspaceDir: workspaceLayout.workspaceDir,
    agentWorkspaceDir: workspaceLayout.agentWorkspaceDir,
    skillsWorkspaceDir: workspaceLayout.skillsWorkspaceDir,
    cfg: sandboxCfg,
  });
  const effectiveHostWorkspaceRoot = sessionIsSandboxed
    ? workspaceLayout.workspaceDir
    : workspaceLayout.agentWorkspaceDir;
  const runtimeWorkdir = sessionIsSandboxed ? sandboxWorkdir : directRuntimeCwd;
  const workspaceSource = sessionIsSandboxed ? workspaceLayout.workspaceSource : "direct";
  const usesLocalContainerMounts =
    sandboxCfg.backend.toLowerCase() === "docker" || sandboxCfg.backend.toLowerCase() === "podman";
  const workspaceMounts =
    sessionIsSandboxed && usesLocalContainerMounts && sandboxWorkdir
      ? buildSandboxFsMounts({
          workspaceDir: workspaceLayout.workspaceDir,
          agentWorkspaceDir: workspaceLayout.agentWorkspaceDir,
          skillsWorkspaceDir: workspaceLayout.skillsWorkspaceDir,
          workspaceAccess: sandboxCfg.workspaceAccess,
          containerName: "",
          containerWorkdir: sandboxWorkdir,
          docker: sandboxCfg.docker,
        })
      : [];

  const channel = resolveActiveChannel({
    cfg,
    entry: sessionEntry,
    sessionKey,
  });

  const elevatedGlobal = cfg.tools?.elevated;
  const elevatedAgent = agentConfig?.tools?.elevated;
  const elevatedGlobalEnabled = elevatedGlobal?.enabled !== false;
  const elevatedAgentEnabled = elevatedAgent?.enabled !== false;
  const elevatedEnabled = elevatedGlobalEnabled && elevatedAgentEnabled;

  const globalAllowTokens = normalizeStringifiedEntries(
    channel ? elevatedGlobal?.allowFrom?.[channel] : undefined,
  );
  const agentAllowTokens = normalizeStringifiedEntries(
    channel ? elevatedAgent?.allowFrom?.[channel] : undefined,
  );

  const elevatedAllowedByConfig =
    elevatedEnabled &&
    Boolean(channel) &&
    globalAllowTokens.length > 0 &&
    (elevatedAgent?.allowFrom ? agentAllowTokens.length > 0 : true);

  const elevatedAlwaysAllowedByConfig =
    elevatedAllowedByConfig &&
    globalAllowTokens.includes("*") &&
    (elevatedAgent?.allowFrom ? agentAllowTokens.includes("*") : true);

  const elevatedFailures: Array<{ gate: string; key: string }> = [];
  // Track each failed gate separately so the human report points at concrete
  // config keys instead of only saying elevated access is disabled.
  if (!elevatedGlobalEnabled) {
    elevatedFailures.push({ gate: "enabled", key: "tools.elevated.enabled" });
  }
  if (!elevatedAgentEnabled) {
    elevatedFailures.push({
      gate: "enabled",
      key: "agents.entries.*.tools.elevated.enabled",
    });
  }
  if (channel && globalAllowTokens.length === 0) {
    elevatedFailures.push({
      gate: "allowFrom",
      key: `tools.elevated.allowFrom.${channel}`,
    });
  }
  if (channel && elevatedAgent?.allowFrom && agentAllowTokens.length === 0) {
    elevatedFailures.push({
      gate: "allowFrom",
      key: `agents.entries.*.tools.elevated.allowFrom.${channel}`,
    });
  }

  const fixIt: string[] = [];
  if (sandboxCfg.mode !== "off") {
    fixIt.push("agents.defaults.sandbox.mode=off");
    fixIt.push("agents.entries.*.sandbox.mode=off");
  }
  fixIt.push("tools.sandbox.tools.allow");
  fixIt.push("tools.sandbox.tools.alsoAllow");
  fixIt.push("tools.sandbox.tools.deny");
  fixIt.push("agents.entries.*.tools.sandbox.tools.allow");
  fixIt.push("agents.entries.*.tools.sandbox.tools.alsoAllow");
  fixIt.push("agents.entries.*.tools.sandbox.tools.deny");
  fixIt.push("tools.elevated.enabled");
  if (channel) {
    fixIt.push(`tools.elevated.allowFrom.${channel}`);
  }

  const payload = {
    docsUrl: SANDBOX_DOCS_URL,
    agentId: resolvedAgentId,
    sessionKey,
    mainSessionKey,
    sandbox: {
      mode: sandboxCfg.mode,
      scope: sandboxCfg.scope,
      backend: sandboxCfg.backend,
      workspaceAccess: sandboxCfg.workspaceAccess,
      workspaceRoot: sandboxCfg.workspaceRoot,
      effectiveHostWorkspaceRoot,
      runtimeWorkdir,
      workspaceMounts,
      workspaceSource,
      sessionIsSandboxed,
      tools: {
        allow: toolPolicy.allow,
        deny: toolPolicy.deny,
        sources: toolPolicy.sources,
      },
    },
    elevated: {
      enabled: elevatedEnabled,
      channel,
      allowedByConfig: elevatedAllowedByConfig,
      alwaysAllowedByConfig: elevatedAlwaysAllowedByConfig,
      allowFrom: {
        global: channel ? globalAllowTokens : undefined,
        agent: elevatedAgent?.allowFrom && channel ? agentAllowTokens : undefined,
      },
      failures: elevatedFailures,
    },
    fixIt,
  } as const;

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  const rich = isRich();
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const key = (value: string) => colorize(rich, theme.muted, value);
  const value = (val: string) => colorize(rich, theme.info, val);
  const ok = (val: string) => colorize(rich, theme.success, val);
  const warn = (val: string) => colorize(rich, theme.warn, val);
  const err = (val: string) => colorize(rich, theme.error, val);
  const bool = (flag: boolean) => (flag ? ok("true") : err("false"));

  const lines = [
    heading("Effective sandbox:"),
    `  ${key("agentId:")} ${value(payload.agentId)}`,
    `  ${key("sessionKey:")} ${value(payload.sessionKey)}`,
    `  ${key("mainSessionKey:")} ${value(payload.mainSessionKey)}`,
    `  ${key("runtime:")} ${payload.sandbox.sessionIsSandboxed ? warn("sandboxed") : ok("direct")}`,
    `  ${key("mode:")} ${value(payload.sandbox.mode)} ${key("scope:")} ${value(
      payload.sandbox.scope,
    )}`,
    `  ${key("workspaceAccess:")} ${value(
      payload.sandbox.workspaceAccess,
    )} ${key("workspaceRoot:")} ${value(payload.sandbox.workspaceRoot)}`,
    `  ${key("effectiveHostWorkspaceRoot:")} ${value(payload.sandbox.effectiveHostWorkspaceRoot)}`,
    `  ${key("backend:")} ${value(payload.sandbox.backend)} ${key("runtimeWorkdir:")} ${value(
      payload.sandbox.runtimeWorkdir ?? "(direct host)",
    )} ${key("workspaceSource:")} ${value(payload.sandbox.workspaceSource)}`,
  ];
  if (payload.sandbox.workspaceMounts.length > 0) {
    lines.push(`  ${key("workspaceMounts:")}`);
    for (const mount of payload.sandbox.workspaceMounts) {
      lines.push(
        `    - ${value(mount.hostRoot)} -> ${value(mount.containerRoot)} ${key(
          mount.writable ? "rw" : "ro",
        )} ${key(`(${mount.source})`)}`,
      );
    }
  }
  lines.push(
    "",
    heading("Sandbox tool policy:"),
    `  ${key(`allow (${payload.sandbox.tools.sources.allow.source}):`)} ${value(
      payload.sandbox.tools.allow.join(", ") || "(empty)",
    )}`,
    `  ${key(`deny  (${payload.sandbox.tools.sources.deny.source}):`)} ${value(
      payload.sandbox.tools.deny.join(", ") || "(empty)",
    )}`,
    "",
    heading("Elevated:"),
    `  ${key("enabled:")} ${bool(payload.elevated.enabled)}`,
    `  ${key("channel:")} ${value(payload.elevated.channel ?? "(unknown)")}`,
    `  ${key("allowedByConfig:")} ${bool(payload.elevated.allowedByConfig)}`,
  );
  if (payload.elevated.failures.length > 0) {
    lines.push(
      `  ${key("failing gates:")} ${warn(
        payload.elevated.failures.map((f) => `${f.gate} (${f.key})`).join(", "),
      )}`,
    );
  }
  if (payload.sandbox.mode === "non-main" && payload.sandbox.sessionIsSandboxed) {
    lines.push("");
    lines.push(
      `${warn("Hint:")} sandbox mode is non-main; use main session key to run direct: ${value(
        payload.mainSessionKey,
      )}`,
    );
  }
  lines.push("", heading("Fix-it:"));
  for (const keyLocal of payload.fixIt) {
    lines.push(`  - ${keyLocal}`);
  }
  lines.push("", `${key("Docs:")} ${formatDocsLink("/sandbox", "docs.openclaw.ai/sandbox")}`);

  runtime.log(`${lines.join("\n")}\n`);
}
