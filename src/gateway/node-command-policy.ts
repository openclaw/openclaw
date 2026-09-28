import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeUniqueStringEntries,
  normalizeUniqueTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_BROWSER_PROXY_COMMANDS,
  NODE_DEVICE_APPS_COMMAND,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_FILE_COMMANDS,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
  NODE_WORKER_PRIVATE_COMMANDS,
  isPrivateNodeInvokeCommand,
} from "../infra/node-commands.js";
import { getActivePluginGatewayNodePolicyRegistry } from "../plugins/runtime-state.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import { normalizeDeviceMetadataForPolicy } from "./device-metadata-normalization.js";
import { MOBILE_NODE_COMMANDS } from "./node-command-policy-mobile.js";

const CAMERA_COMMANDS = ["camera.list"];
const MAC_CAMERA_COMMANDS = ["camera.ptz.status"];

const CAMERA_DANGEROUS_COMMANDS = ["camera.snap", "camera.clip", "camera.ptz.control"];

const SCREEN_COMMANDS = ["screen.snapshot"];
const SCREEN_DANGEROUS_COMMANDS = ["screen.record"];
const DESKTOP_SCREEN_COMMANDS = [...SCREEN_COMMANDS, NODE_DESKTOP_STREAM_COMMAND];

// Desktop computer use is advertised only while the node-local control is
// enabled. Pairing approval of that advertised surface is the durable grant.
const COMPUTER_COMMANDS = ["computer.act"];

// Android advertises these only while Accessibility Control is enabled. The
// action tool adds its own model-visible confirmation contract for mutations.
const MOBILE_UI_COMMANDS = ["mobile.ui.observe", "mobile.ui.act"];

const ANDROID_DEVICE_COMMANDS = [
  ...MOBILE_NODE_COMMANDS.device,
  "device.permissions",
  "device.health",
  NODE_DEVICE_APPS_COMMAND,
];

const CONTACTS_COMMANDS = ["contacts.search"];
const CONTACTS_DANGEROUS_COMMANDS = ["contacts.add"];

const CALENDAR_COMMANDS = ["calendar.events"];
const CALENDAR_DANGEROUS_COMMANDS = ["calendar.add"];

const CALL_LOG_COMMANDS = ["callLog.search"];

const REMINDERS_COMMANDS = ["reminders.list"];
const REMINDERS_DANGEROUS_COMMANDS = ["reminders.add"];

const PHOTOS_COMMANDS = ["photos.latest"];

const MOTION_COMMANDS = ["motion.activity", "motion.pedometer"];

const HEALTH_DANGEROUS_COMMANDS = ["health.summary"];

const SMS_DANGEROUS_COMMANDS = ["sms.send", "sms.search"];

export const TALK_PTT_COMMANDS = [
  "talk.ptt.start",
  "talk.ptt.stop",
  "talk.ptt.cancel",
  "talk.ptt.once",
];

// The iPhone node owns the relay to its companion Watch. Keep these commands
// out of the direct watchOS node surface, which has a separate fixed policy.
export const IOS_WATCH_RELAY_COMMANDS = ["watch.status", "watch.notify"];

// iOS nodes don't implement system.run/which, but they do support notifications.
const IOS_SYSTEM_COMMANDS = [NODE_SYSTEM_NOTIFY_COMMAND];

const SYSTEM_COMMANDS = [
  ...NODE_SYSTEM_RUN_COMMANDS,
  ...NODE_EXEC_APPROVALS_COMMANDS,
  ...NODE_FILE_COMMANDS,
  NODE_SYSTEM_NOTIFY_COMMAND,
  ...NODE_BROWSER_PROXY_COMMANDS,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
];
const DESKTOP_HOST_COMMANDS = new Set<string>([
  ...NODE_SYSTEM_RUN_COMMANDS,
  ...NODE_EXEC_APPROVALS_COMMANDS,
  ...NODE_FILE_COMMANDS,
  ...NODE_BROWSER_PROXY_COMMANDS,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  ...SCREEN_COMMANDS,
  NODE_DESKTOP_STREAM_COMMAND,
]);
const UNKNOWN_PLATFORM_COMMANDS = [
  ...CAMERA_COMMANDS,
  ...MOBILE_NODE_COMMANDS.location,
  NODE_SYSTEM_NOTIFY_COMMAND,
];

// "High risk" node commands. These can be enabled by explicitly adding them to
// `gateway.nodes.commands.allow` (and ensuring they're not blocked by commands.deny).
export const DEFAULT_DANGEROUS_NODE_COMMANDS = [
  ...CAMERA_DANGEROUS_COMMANDS,
  ...SCREEN_DANGEROUS_COMMANDS,
  ...CONTACTS_DANGEROUS_COMMANDS,
  ...CALENDAR_DANGEROUS_COMMANDS,
  ...REMINDERS_DANGEROUS_COMMANDS,
  ...SMS_DANGEROUS_COMMANDS,
  ...HEALTH_DANGEROUS_COMMANDS,
];

export const PLATFORM_DEFAULTS: Record<PlatformId, string[]> = {
  ios: [
    ...CAMERA_COMMANDS,
    ...MOBILE_NODE_COMMANDS.location,
    ...MOBILE_NODE_COMMANDS.device,
    ...CONTACTS_COMMANDS,
    ...CALENDAR_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...MOTION_COMMANDS,
    ...IOS_SYSTEM_COMMANDS,
  ],
  watchos: [...MOBILE_NODE_COMMANDS.device, ...IOS_SYSTEM_COMMANDS],
  android: [
    ...CAMERA_COMMANDS,
    ...MOBILE_NODE_COMMANDS.location,
    ...MOBILE_NODE_COMMANDS.androidNotification,
    NODE_SYSTEM_NOTIFY_COMMAND,
    ...ANDROID_DEVICE_COMMANDS,
    ...CONTACTS_COMMANDS,
    ...CALENDAR_COMMANDS,
    ...CALL_LOG_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...MOTION_COMMANDS,
    ...MOBILE_UI_COMMANDS,
  ],
  macos: [
    ...CAMERA_COMMANDS,
    ...MAC_CAMERA_COMMANDS,
    ...MOBILE_NODE_COMMANDS.location,
    ...MOBILE_NODE_COMMANDS.device,
    NODE_DEVICE_APPS_COMMAND,
    ...CONTACTS_COMMANDS,
    ...CALENDAR_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...MOTION_COMMANDS,
    ...SYSTEM_COMMANDS,
    ...DESKTOP_SCREEN_COMMANDS,
    ...COMPUTER_COMMANDS,
  ],
  linux: [...SYSTEM_COMMANDS, ...DESKTOP_SCREEN_COMMANDS, ...COMPUTER_COMMANDS],
  windows: [
    ...CAMERA_COMMANDS,
    ...MOBILE_NODE_COMMANDS.location,
    ...MOBILE_NODE_COMMANDS.device,
    ...SYSTEM_COMMANDS,
    ...DESKTOP_SCREEN_COMMANDS,
    ...COMPUTER_COMMANDS,
  ],
  // Fail-safe: unknown metadata should not receive host exec defaults.
  unknown: [...UNKNOWN_PLATFORM_COMMANDS],
};
type PlatformId = "ios" | "watchos" | "android" | "macos" | "windows" | "linux" | "unknown";

const PLATFORM_RULES: ReadonlyArray<{
  id: Exclude<PlatformId, "unknown">;
  tokens: readonly string[];
  nativeLabel?: RegExp;
  allowEmptyFamily?: boolean;
}> = [
  {
    id: "ios",
    tokens: ["iphone", "ipad", "ios"],
    nativeLabel: /^(?:ios|ipados) \d+(?:\.\d+){0,2}$/,
    allowEmptyFamily: true,
  },
  {
    id: "watchos",
    tokens: ["apple watch", "watchos"],
    nativeLabel: /^watchos \d+(?:\.\d+){0,2}$/,
  },
  {
    id: "android",
    tokens: ["android"],
    nativeLabel: /^android \d+(?: \(sdk \d+\))?$/,
    allowEmptyFamily: true,
  },
  {
    id: "macos",
    tokens: ["mac"],
    nativeLabel: /^macos \d+(?:\.\d+){0,2}$/,
  },
  { id: "windows", tokens: ["windows"] },
  { id: "linux", tokens: ["linux"] },
];

function normalizePlatformId(platform?: string, deviceFamily?: string): PlatformId {
  const raw = normalizeDeviceMetadataForPolicy(platform);
  const family = normalizeDeviceMetadataForPolicy(deviceFamily);
  if (raw) {
    const rule = PLATFORM_RULES.find((candidate) => candidate.id === raw);
    if (rule) {
      return rule.tokens.includes(family) || (family === "" && rule.allowEmptyFamily)
        ? rule.id
        : "unknown";
    }
    return (
      PLATFORM_RULES.find(
        (candidate) => candidate.nativeLabel?.test(raw) && candidate.tokens.includes(family),
      )?.id ?? "unknown"
    );
  }
  return (
    PLATFORM_RULES.find((rule) => rule.tokens.some((token) => family.includes(token)))?.id ??
    "unknown"
  );
}

export function listDangerousPluginNodeCommands(): string[] {
  const registry = getActivePluginGatewayNodePolicyRegistry();
  if (!registry) {
    return [];
  }
  return normalizeUniqueStringEntries([
    ...registry.nodeHostCommands.flatMap(({ command }) =>
      command.dangerous === true ? [command.command] : [],
    ),
    ...registry.nodeInvokePolicies.flatMap(({ policy }) =>
      policy.dangerous === true ? policy.commands : [],
    ),
  ]);
}

function listDefaultPluginNodeCommands(platformId: PlatformId): string[] {
  // The direct watch transport has a fixed, minimal command surface. Do not let
  // generic plugin defaults silently expand it when plugins are installed.
  if (platformId === "watchos") {
    return [];
  }
  const registry = getActivePluginGatewayNodePolicyRegistry();
  if (!registry) {
    return [];
  }
  return normalizeUniqueStringEntries([
    ...registry.nodeInvokePolicies.flatMap(({ policy }) =>
      policy.dangerous !== true && policy.defaultPlatforms?.includes(platformId)
        ? policy.commands
        : [],
    ),
    ...registry.nodeHostCommands.flatMap(({ command: { dangerous, agentTool, command } }) =>
      dangerous !== true && agentTool?.defaultPlatforms?.includes(platformId) ? [command] : [],
    ),
  ]);
}

export function isForegroundRestrictedPluginNodeCommand(command: string): boolean {
  const registry = getActivePluginGatewayNodePolicyRegistry();
  const normalized = command.trim();
  if (!registry || !normalized) {
    return false;
  }
  return registry.nodeInvokePolicies.some(
    (entry) =>
      entry.policy.foregroundRestrictedOnIos === true &&
      entry.policy.commands.some((policyCommand) => policyCommand.trim() === normalized),
  );
}
type NodeCommandPolicyNode = {
  platform?: string;
  deviceFamily?: string;
  caps?: string[];
  commands?: string[];
  connId?: string;
  nodeId?: string;
  approvedCommands?: readonly string[];
};

function isLiveNodeSession(node: NodeCommandPolicyNode | undefined): boolean {
  return (
    typeof node?.nodeId === "string" &&
    node.nodeId.trim() !== "" &&
    typeof node.connId === "string" &&
    node.connId.trim() !== ""
  );
}

function hasTalkSurface(node?: NodeCommandPolicyNode): boolean {
  return (
    (node?.caps ?? []).some(
      (capability) => normalizeOptionalLowercaseString(capability) === "talk",
    ) ||
    (node?.commands ?? []).some((command) =>
      normalizeOptionalLowercaseString(command)?.startsWith("talk."),
    )
  );
}

function resolveNodeCommandAllowlistInternal(
  cfg: OpenClawConfig,
  node?: NodeCommandPolicyNode,
  options?: { includeDesktopHostCommands?: boolean; includeDangerousDefaults?: boolean },
): Set<string> {
  const platformId = normalizePlatformId(node?.platform, node?.deviceFamily);
  const desktop = platformId === "macos" || platformId === "windows" || platformId === "linux";
  const base = PLATFORM_DEFAULTS[platformId].filter(
    (command) =>
      options?.includeDesktopHostCommands === true ||
      !desktop ||
      !DESKTOP_HOST_COMMANDS.has(command),
  );
  const watchRelayCommands =
    platformId === "ios" && normalizeDeviceMetadataForPolicy(node?.deviceFamily) === "iphone"
      ? IOS_WATCH_RELAY_COMMANDS
      : [];
  const talkCommands = hasTalkSurface(node) ? TALK_PTT_COMMANDS : [];
  const pluginDefaults = listDefaultPluginNodeCommands(platformId);
  // Desktop host commands need pairing approval instead of ordinary session defaults.
  const approved = desktop
    ? (node?.approvedCommands ?? (isLiveNodeSession(node) ? (node?.commands ?? []) : [])).filter(
        (command) => DESKTOP_HOST_COMMANDS.has(command.trim()),
      )
    : [];
  const extra = cfg.gateway?.nodes?.commands?.allow ?? [];
  const deny = new Set(cfg.gateway?.nodes?.commands?.deny ?? []);
  // A plugin `dangerous` flag governs the surface that plugin contributes
  // (listDefaultPluginNodeCommands) and forces a registered invoke policy. It is
  // not authority to revoke a command core itself declares in PLATFORM_DEFAULTS,
  // whose grant chain is node-local enablement plus pairing approval. Letting it
  // do so disabled desktop `computer.act` on every Gateway that auto-starts a
  // bundled computer-use provider plugin.
  const baseCommands = new Set(base);
  const dangerousPluginCommands = new Set(
    listDangerousPluginNodeCommands().filter((command) => !baseCommands.has(command)),
  );
  // Dangerous built-ins that also appear in PLATFORM_DEFAULTS stay declarable
  // at pairing but do not enter the runtime allowlist by default.
  const dangerousBuiltinCommands =
    options?.includeDangerousDefaults === true
      ? new Set<string>()
      : new Set(DEFAULT_DANGEROUS_NODE_COMMANDS);
  // Dangerous plugin commands are excluded from plugin defaults. Explicit
  // gateway.nodes.commands.allow below can still opt them in for operators.
  const allow = new Set(
    [...base, ...watchRelayCommands, ...talkCommands, ...pluginDefaults, ...approved, ...extra]
      .map((cmd) => cmd.trim())
      .filter(
        (cmd) => cmd && !dangerousPluginCommands.has(cmd) && !dangerousBuiltinCommands.has(cmd),
      ),
  );
  for (const cmd of extra) {
    const trimmed = cmd.trim();
    if (trimmed) {
      allow.add(trimmed);
    }
  }
  if (cfg.wizard?.appRecommendations === false) {
    allow.delete(NODE_DEVICE_APPS_COMMAND);
  }
  // In pairing mode, denylisted dangerous defaults stay declarable so an
  // explicit persistent allow can authorize them without another pairing.
  // Invoke-time policy still honors deny in full.
  const denyExemptDeclarable =
    options?.includeDangerousDefaults === true
      ? new Set(DEFAULT_DANGEROUS_NODE_COMMANDS)
      : new Set<string>();
  for (const blocked of deny) {
    const trimmed = blocked.trim();
    if (trimmed && !denyExemptDeclarable.has(trimmed)) {
      allow.delete(trimmed);
    }
  }
  for (const privateCommand of NODE_WORKER_PRIVATE_COMMANDS) {
    allow.delete(privateCommand);
  }
  return allow;
}

export function resolveNodeCommandAllowlist(
  cfg: OpenClawConfig,
  node?: NodeCommandPolicyNode,
): Set<string> {
  return resolveNodeCommandAllowlistInternal(cfg, node);
}

export function resolveNodePairingCommandAllowlist(
  cfg: OpenClawConfig,
  node?: NodeCommandPolicyNode,
): Set<string> {
  return resolveNodeCommandAllowlistInternal(cfg, node, {
    includeDesktopHostCommands: true,
    includeDangerousDefaults: true,
  });
}

export function normalizeDeclaredNodeCommands(params: {
  declaredCommands?: readonly string[];
  allowlist: Set<string>;
}): string[] {
  return normalizeUniqueTrimmedStringList(params.declaredCommands).filter(
    (command) => !isPrivateNodeInvokeCommand(command) && params.allowlist.has(command),
  );
}

// Capability and command are one advertisement: a node offers `computer` because
// it can run `computer.act`. Keeping the capability after policy withheld every
// command that fulfills it yields a surface that reads as available and then
// rejects every invoke. Families core does not own here stay untouched.
const CAPABILITY_COMMAND_FAMILIES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["camera", new Set([...CAMERA_COMMANDS, ...MAC_CAMERA_COMMANDS, ...CAMERA_DANGEROUS_COMMANDS])],
  ["computer", new Set(COMPUTER_COMMANDS)],
  ["location", new Set(MOBILE_NODE_COMMANDS.location)],
  ["screen", new Set([...DESKTOP_SCREEN_COMMANDS, ...SCREEN_DANGEROUS_COMMANDS])],
]);

/** Drops capabilities whose commands policy withheld without admitting a sibling. */
export function retainFulfilledNodeCapabilities(params: {
  caps: readonly string[];
  admittedCommands: readonly string[];
  withheldCommands: readonly string[];
}): string[] {
  return params.caps.filter((capability) => {
    const family = CAPABILITY_COMMAND_FAMILIES.get(capability);
    return (
      !family ||
      !params.withheldCommands.some((command) => family.has(command)) ||
      params.admittedCommands.some((command) => family.has(command))
    );
  });
}

export function isNodeCommandAllowed(params: {
  command: string;
  declaredCommands?: readonly string[];
  allowlist: Set<string>;
}): { ok: true } | { ok: false; reason: string } {
  const command = params.command.trim();
  if (!command) {
    return { ok: false, reason: "command required" };
  }
  if (isPrivateNodeInvokeCommand(command) || !params.allowlist.has(command)) {
    return { ok: false, reason: "command not allowlisted" };
  }
  if (Array.isArray(params.declaredCommands) && params.declaredCommands.length > 0) {
    if (!params.declaredCommands.includes(command)) {
      return { ok: false, reason: "command not declared by node" };
    }
  } else {
    return { ok: false, reason: "node did not declare commands" };
  }
  return { ok: true };
}

export type RequiredNodeCommandAuthority = {
  command: string;
  state: "invocable" | "pending-approval" | "undeclared" | "unauthorized";
};

/** Present the failed authority layer without suggesting that another layer can grant it. */
export function formatRequiredNodeCommandUnavailable(
  authority: RequiredNodeCommandAuthority,
  nodeId: string,
): string | undefined {
  const { command, state } = authority;
  const prefix = `paired-device command ${command}`;
  switch (state) {
    case "undeclared": {
      const registry = getActivePluginGatewayNodePolicyRegistry();
      const pluginId = registry?.nodeHostCommands.find(
        (entry) => entry.command.command === command,
      )?.pluginId;
      const enable = pluginId
        ? `${pluginId === "codex" ? "install the codex plugin on that node if missing (openclaw plugins install @openclaw/codex), then " : ""}enable the ${pluginId} plugin on that node (openclaw plugins enable ${pluginId})`
        : "enable the plugin or node capability that provides this command on that node";
      return `${prefix} is not advertised by node ${nodeId}; ${enable}, then restart the node (openclaw node restart) and approve its updated command surface`;
    }
    case "pending-approval":
      return `${prefix} is awaiting pairing approval for node ${nodeId}; find its updated command surface request with openclaw nodes pending, then run openclaw nodes approve <requestId>`;
    case "unauthorized":
      return `${prefix} is blocked by Gateway policy for node ${nodeId}; allow it in gateway.nodes.commands.allow and remove any matching gateway.nodes.commands.deny entry`;
  }
  return undefined;
}

/**
 * Resolves declaration, pairing, and runtime policy once at their Gateway owner.
 * Clients receive one closed state instead of rebuilding authority from partial lists.
 */
export function resolveRequiredNodeCommandAuthority(params: {
  requiredCommands: readonly string[];
  declaredCommands: readonly string[];
  effectiveCommands: readonly string[];
  withheldCommands: readonly string[];
  allowlist: Set<string>;
}): RequiredNodeCommandAuthority | undefined {
  const declaredCommands = new Set(params.declaredCommands);
  const effectiveCommands = new Set(params.effectiveCommands);
  // A denial anywhere in the required set takes precedence over pairing approval.
  const denied = params.requiredCommands.find((cmd) => params.withheldCommands.includes(cmd));
  if (denied) {
    return { command: denied, state: "unauthorized" };
  }
  for (const command of params.requiredCommands) {
    if (
      effectiveCommands.has(command) &&
      isNodeCommandAllowed({
        command,
        declaredCommands: params.effectiveCommands,
        allowlist: params.allowlist,
      }).ok
    ) {
      continue;
    }
    if (declaredCommands.has(command) && !effectiveCommands.has(command)) {
      return { command, state: "pending-approval" };
    }
    if (declaredCommands.has(command)) {
      return { command, state: "unauthorized" };
    }
    return { command, state: "undeclared" };
  }
  const command = params.requiredCommands[0];
  return command ? { command, state: "invocable" } : undefined;
}
