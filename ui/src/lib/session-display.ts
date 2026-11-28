import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSignal } from "solid-js";
import { isCronSessionDisplayKey } from "../../../src/shared/session-list-visibility.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { pathDisplayName } from "./path-display.ts";

const CHANNEL_LABELS = new Map<string, string>([
  ["imessage", "iMessage"],
  ["telegram", "Telegram"],
  ["discord", "Discord"],
  ["signal", "Signal"],
  ["slack", "Slack"],
  ["whatsapp", "WhatsApp"],
  ["matrix", "Matrix"],
  ["msteams", "Microsoft Teams"],
  ["bluebubbles", "BlueBubbles"],
  ["googlechat", "Google Chat"],
  ["mattermost", "Mattermost"],
  ["irc", "IRC"],
  ["email", "Email"],
  ["sms", "SMS"],
]);

// Long hex/uuid runs inside keys and node ids are machine ids, not names;
// keep a short recognizable tail so rows never fill with opaque hashes.
const OPAQUE_ID_RUN_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{10,}/gi;

export function shortenOpaqueIdRuns(text: string): string {
  return text.replace(OPAQUE_ID_RUN_RE, (match) => `…${match.slice(-4)}`);
}

const WORKTREE_BRANCH_PREFIX = "openclaw/";

// `dm` is the pre-#11881 spelling of `direct`; those keys still persist and the
// canonical parser still accepts both (src/sessions/session-key-utils.ts).
// Only direct chats take an account segment (src/routing/session-key.ts), so an
// account-qualified group or channel key is not a shape any producer emits and
// must not name a channel here either. `:thread:` is a suffix on a complete base
// key (resolveThreadSessionKeys), so the segment before it is never a channel:
// a Telegram DM topic under dmScope=main is `agent:<id>:main:thread:<chat>:<topic>`.
const CHANNEL_SESSION_KEY_RE =
  /^agent:[^:]+:([^:]+)(?:(?::[^:]+)?:(?:direct|dm)|:(?:group|channel)):/;
const PEER_SESSION_KEY_RE = /:(?:direct|dm|group|channel|thread):/;
const DIRECT_SESSION_KEY_RE = /:(?:direct|dm):/;

/**
 * Classifies channel-originated sessions for the sidebar's built-in channel
 * sections. Agent main and dashboard sessions stay out even when they carry
 * channel routing metadata (dmScope=main keeps Main as the anchor chat).
 */
export function resolveChannelSessionInfo(
  key: string,
  rowChannel?: string,
): { channel?: string; channelSession: boolean } {
  if (!PEER_SESSION_KEY_RE.test(key)) {
    return { channelSession: false };
  }
  const keyChannel = key.match(CHANNEL_SESSION_KEY_RE)?.[1];
  const channel = normalizeOptionalString(keyChannel) ?? normalizeOptionalString(rowChannel);
  return { channel, channelSession: Boolean(channel) };
}

// Phone metadata costs ~30 KB gzip, so it loads only once a phone peer is shown.
// Readers show the plain number until then and refresh through the signal.
let formatPhoneNumber: ((raw: string) => string | undefined) | undefined;
let phoneFormatterLoad: Promise<void> | undefined;
const [phoneFormatterReady, setPhoneFormatterReady] = createSignal(false);

/** Cached projections key on this so their numbers reformat once metadata lands. */
export const channelPhoneFormatterReady = phoneFormatterReady;

export function loadChannelPhoneFormatter(): Promise<void> {
  phoneFormatterLoad ??= import("@openclaw/normalization-core/phone-presentation").then(
    (module) => {
      formatPhoneNumber = module.formatInternationalPhoneNumber;
      setPhoneFormatterReady(true);
    },
    // A failed chunk leaves numbers unformatted, which still reads correctly.
    () => undefined,
  );
  return phoneFormatterLoad;
}

// Channels whose direct-chat peers are addressed by phone number or email.
const PHONE_ADDRESS_CHANNELS = new Set(["whatsapp", "signal", "imessage", "bluebubbles", "sms"]);

/** A readable phone number or email for a direct-chat peer, when the channel addresses peers that way. */
export function formatChannelPeerAddress(channel: string, peer: string): string | undefined {
  if (!PHONE_ADDRESS_CHANNELS.has(channel)) {
    return undefined;
  }
  const value = peer.trim().replace(/^(?:whatsapp|signal|imessage|bluebubbles|sms|auto):/i, "");
  if (/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(value)) {
    return value;
  }
  // WhatsApp phone JIDs are digits; privacy LIDs and group JIDs are not phone numbers.
  const digits = value.match(/^\+?(\d{7,15})(?:@s\.whatsapp\.net)?$/i)?.[1];
  if (!digits) {
    return undefined;
  }
  const number = `+${digits}`;
  phoneFormatterReady();
  if (!formatPhoneNumber) {
    void loadChannelPhoneFormatter();
    return number;
  }
  return formatPhoneNumber(number) ?? number;
}

/**
 * Drops the id suffixes bundled ingress producers append to conversation labels.
 * They disambiguate for agents; people read the name.
 */
export function channelConversationLabel(
  channel: string,
  rawLabel: string | undefined,
): string | undefined {
  let label = rawLabel;
  if (!label) {
    return undefined;
  }
  if (channel === "discord") {
    label = label.replace(/ (?:user|channel) id:\d+$/, "");
  } else if (channel === "telegram") {
    label = label.replace(/(?:^| )id:-?\d+(?: topic:\d+)?$/, "");
    if (/^(?:id:unknown|group:-?\d+(?: topic:\d+)?)$/.test(label)) {
      return undefined;
    }
  } else if (channel === "signal") {
    label = label.replace(/ id:\S+$/, "");
  }
  return normalizeOptionalString(label);
}

/** Telegram labels a person as "Name (@handle)"; the name leads and the handle is detail. */
export function splitChannelContactLabel(label: string): { name: string; handle?: string } {
  const match = label.match(/^(.+?) \((@[^\s()]+)\)$/);
  return match ? { name: match[1]!, handle: match[2] } : { name: label };
}

type SessionWorktreeDisplayRow = {
  worktree?: { branch?: string; repoRoot?: string };
  repository?: { url: string; branch: string };
  placement?: GatewaySessionRow["placement"];
  execNode?: string;
  execCwd?: string;
  deviceFolder?: { deviceId: string; path: string };
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
};

function resolveWorktreeBranch(row: SessionWorktreeDisplayRow): string | undefined {
  const branch =
    normalizeOptionalString(row.repository?.branch) ??
    normalizeOptionalString(row.worktree?.branch);
  return !row.repository && branch?.startsWith(WORKTREE_BRANCH_PREFIX)
    ? branch.slice(WORKTREE_BRANCH_PREFIX.length)
    : branch;
}

export type SessionWorkContext =
  | { kind: "project"; name: string; path: string; cwd?: string; branch?: string }
  | { kind: "workspace"; name: string; path: string };

export function resolveSessionWorkContext(
  row: SessionWorktreeDisplayRow,
): SessionWorkContext | undefined {
  if (row.deviceFolder) {
    return {
      kind: "workspace",
      name: pathDisplayName(row.deviceFolder.path),
      path: row.deviceFolder.path,
    };
  }
  // Cloud repository identity is not a Gateway filesystem path. A bare node
  // cwd likewise must not borrow repository facts from a local worktree.
  const repoRoot =
    normalizeOptionalString(row.repository?.url.replace(/\.git$/u, "")) ??
    (row.execNode ? undefined : normalizeOptionalString(row.worktree?.repoRoot));
  if (repoRoot) {
    const remoteDirectory =
      row.placement && "remoteWorkspaceDir" in row.placement
        ? normalizeOptionalString(row.placement.remoteWorkspaceDir)
        : undefined;
    const repositoryDirectory =
      remoteDirectory ?? (row.execNode ? normalizeOptionalString(row.execCwd) : undefined);
    return {
      kind: "project",
      name: pathDisplayName(repoRoot),
      // Project grouping uses the source repository, not this task checkout.
      path: repoRoot,
      cwd: row.repository ? repositoryDirectory : normalizeOptionalString(row.spawnedCwd),
      branch: resolveWorktreeBranch(row),
    };
  }

  // Match the chat workspace owner: local spawned sessions own their recorded
  // workspace first, then their spawned cwd.
  const workspacePath = row.execNode
    ? normalizeOptionalString(row.execCwd)
    : (normalizeOptionalString(row.spawnedWorkspaceDir) ?? normalizeOptionalString(row.spawnedCwd));
  return workspacePath
    ? { kind: "workspace", name: pathDisplayName(workspacePath), path: workspacePath }
    : undefined;
}

/** Compact "repo ⎇ branch" (plus node host) line for worktree/work sessions. */
export function resolveSessionWorkSubtitle(row: SessionWorktreeDisplayRow): string | undefined {
  if (row.deviceFolder) {
    return `${row.deviceFolder.path} · ${shortenOpaqueIdRuns(row.deviceFolder.deviceId)}`;
  }
  // execNode is often a raw node id (long hex); never render it in full.
  const rawNode = normalizeOptionalString(row.execNode);
  const node = rawNode ? shortenOpaqueIdRuns(rawNode) : undefined;
  const repoRoot =
    normalizeOptionalString(row.repository?.url.replace(/\.git$/u, "")) ??
    normalizeOptionalString(row.worktree?.repoRoot);
  const branch = resolveWorktreeBranch(row);
  const checkout = repoRoot
    ? branch
      ? `${pathDisplayName(repoRoot)} ⎇ ${branch}`
      : pathDisplayName(repoRoot)
    : undefined;
  if (checkout && node) {
    // Checkout first: it names the work; the node is routing detail.
    return `${checkout} · ${node}`;
  }
  return checkout ?? node;
}

type SessionDisplayRow = {
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  channel?: string;
  /** Canonical account projected from the delivery route by the Gateway. */
  accountId?: string;
} & SessionWorktreeDisplayRow;

/** Naming has a separate lifetime from the first reply; a usable name always wins. */
export function isSessionTitlePending(
  key: string,
  row?: SessionDisplayRow & { titlePending?: boolean },
): boolean {
  return (
    /^agent:[^:]+:dashboard:/.test(key) &&
    row?.titlePending === true &&
    ![row.label, row.displayName, row.derivedTitle].some(
      (name) => name?.trim() && name.trim() !== key,
    )
  );
}

export function formatSessionChannelLabel(channel: string): string {
  return CHANNEL_LABELS.get(channel) ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

function parseSessionKey(key: string): {
  /** Typed-session identity; display branching keys off this, not label text. */
  kind?: "subagent" | "automation";
  /** Catalog-backed prefix for typed sessions. Empty for others. */
  prefix: string;
  /** Human-readable fallback when no label / displayName is available. */
  fallbackName: string;
  /** Raw account segment; only a fallback, Gateway rows carry the real one. */
  accountId?: string;
} {
  const normalized = normalizeLowercaseStringOrEmpty(key);

  if (key === "main" || /^agent:[^:]+:main$/u.test(key)) {
    return { prefix: "", fallbackName: "Main session" };
  }

  if (key.includes(":subagent:")) {
    const prefix = t("sessionsView.subagentPrefix");
    return { kind: "subagent", prefix, fallbackName: prefix.replace(/:\s*$/u, "") };
  }

  // Automation (cron) job. Session keys keep the `cron:` prefix; only the
  // display strings use the Automations feature name.
  if (normalized.startsWith("cron:") || key.includes(":cron:")) {
    const prefix = t("sessionsView.automationPrefix");
    return { kind: "automation", prefix, fallbackName: prefix };
  }

  // Direct chat: agent:<x>:<channel>[:<account>]:(direct|dm):<id>. Never render
  // the raw peer id; the gateway sends origin-derived names, so this is a last
  // resort.
  const directMatch = key.match(/^agent:[^:]+:([^:]+)(?::([^:]+))?:(?:direct|dm):(.+)$/);
  if (directMatch) {
    const channel = directMatch[1];
    const accountId = directMatch[2];
    const identifier = directMatch[3];
    if (!channel || !identifier) {
      return { prefix: "", fallbackName: key, accountId };
    }
    const peerId = identifier.trim();
    const address = formatChannelPeerAddress(channel, peerId);
    if (address) {
      return { prefix: "", fallbackName: address, accountId };
    }
    const channelLabel = formatSessionChannelLabel(channel);
    const peerLabel = peerId.length <= 10 ? peerId : `…${sliceUtf16Safe(peerId, -6)}`;
    return {
      prefix: "",
      fallbackName: `${channelLabel} · ${peerLabel}`,
      accountId,
    };
  }

  // Group chat: agent:<x>:<channel>:group:<id>. buildAgentPeerSessionKey scopes
  // accounts to DMs (src/routing/session-key.ts), so an account-looking segment
  // here belongs to a custom key and must not be read as one.
  const groupMatch = key.match(/^agent:[^:]+:([^:]+):group:(.+)$/);
  if (groupMatch) {
    const channel = groupMatch[1];
    if (!channel) {
      return { prefix: "", fallbackName: key };
    }
    const channelLabel = formatSessionChannelLabel(channel);
    return { prefix: "", fallbackName: `${channelLabel} Group` };
  }

  // Channel-prefixed keys like "telegram:123": durable session rows written by
  // pre-agent-scoped builds still surface in session lists; label, don't leak keys.
  for (const [ch, label] of CHANNEL_LABELS) {
    if (key === ch || key.startsWith(`${ch}:`)) {
      return { prefix: "", fallbackName: `${label} Session` };
    }
  }

  // Dashboard sessions get generated titles asynchronously; the opaque uuid key
  // must not flash in the sidebar while that title is pending.
  if (/^agent:[^:]+:dashboard:/.test(key)) {
    return { prefix: "", fallbackName: "New session" };
  }

  // Remaining agent keys are named subsessions (CLI --session-id and friends):
  // drop the agent:<id>: routing boilerplate and shorten opaque id runs so the
  // slug reads as a name instead of a raw key.
  const agentKeyMatch = key.match(/^agent:[^:]+:(?:explicit:)?(.+)$/);
  const agentKeyName = agentKeyMatch?.[1];
  if (agentKeyName) {
    return { prefix: "", fallbackName: shortenOpaqueIdRuns(agentKeyName) };
  }

  return { prefix: "", fallbackName: key };
}

export function resolveSessionDisplayName(key: string, row?: SessionDisplayRow): string {
  const label = normalizeOptionalString(row?.label);
  const displayName = normalizeOptionalString(row?.displayName);
  const derivedTitle = normalizeOptionalString(row?.derivedTitle);
  const { kind, prefix, fallbackName, accountId: keyAccountId } = parseSessionKey(key);
  // The Gateway records the account on the row (src/gateway/session-classification.ts);
  // the key is parsed only for panes rendered before their row arrives.
  const accountId = normalizeOptionalString(row?.accountId) ?? keyAccountId;

  const applyTypedPrefix = (rawName: string): string => {
    if (!kind || !prefix) {
      return rawName;
    }
    // Persisted automation sessions carry pre-rename "Cron:"/"Cron Job:"
    // labels; strip them so the renamed prefix does not double up as
    // "Automation: Cron: …".
    const name =
      kind === "automation"
        ? rawName.replace(/^cron(\s+job)?:\s*/i, "").trim() || rawName
        : rawName;
    const prefixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i");
    if (kind === "subagent") {
      return name.replace(prefixPattern, "").trim() || fallbackName;
    }
    return prefixPattern.test(name) ? name : `${prefix} ${name}`;
  };

  let name = fallbackName;
  if (label && label !== key) {
    name = applyTypedPrefix(label);
  } else if (displayName && displayName !== key) {
    const channel = resolveChannelSessionInfo(key, row?.channel).channel;
    if (channel) {
      // Bare ingress ids ("id:unknown", "group:-100…") name nobody; the key fallback reads better.
      const conversation = channelConversationLabel(channel, displayName);
      const direct = DIRECT_SESSION_KEY_RE.test(key);
      const contact =
        conversation && direct ? splitChannelContactLabel(conversation).name : conversation;
      name = contact
        ? applyTypedPrefix((direct && formatChannelPeerAddress(channel, contact)) || contact)
        : fallbackName;
    } else {
      name = applyTypedPrefix(displayName);
    }
  } else {
    // Unnamed work sessions read as their checkout instead of an opaque key.
    const workSubtitle = row ? resolveSessionWorkSubtitle(row) : undefined;
    if (workSubtitle && row?.worktree) {
      name = applyTypedPrefix(workSubtitle);
    } else if (derivedTitle && derivedTitle !== key) {
      name = applyTypedPrefix(derivedTitle);
    }
  }
  if (!accountId || accountId === "default") {
    return name;
  }
  // Preserve account suffixes stored by older clients.
  const suffix = ` · ${accountId}`;
  return name.endsWith(suffix) ? name : `${name}${suffix}`;
}

// Wire kinds exclude cron; labels, sorting and grouping share this display classification.
export function resolveSessionDisplayKind(
  row: GatewaySessionRow,
): GatewaySessionRow["kind"] | "cron" {
  return isCronSessionDisplayKey(row.key) ? "cron" : row.kind;
}
