import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { lookupContextTokens } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { resolveEffectiveToolInventory } from "../agents/tools-effective-inventory.js";
import { resolveReplyToMode } from "../auto-reply/reply/reply-threading.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveFreshSessionTotalTokens } from "../config/sessions.js";
import {
  classifySessionKey,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
} from "../gateway/session-utils.js";
import { info } from "../globals.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import { deliveryContextFromSession } from "../utils/delivery-context.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";
import {
  formatSessionAgeCell,
  formatSessionFlagsCell,
  formatSessionKeyCell,
  formatSessionModelCell,
  resolveSessionDisplayDefaults,
  resolveSessionDisplayModel,
  SESSION_AGE_PAD,
  SESSION_KEY_PAD,
  SESSION_MODEL_PAD,
  type SessionDisplayRow,
  toSessionDisplayRows,
} from "./sessions-table.js";

type SessionRow = SessionDisplayRow & {
  agentId: string;
  kind: "direct" | "group" | "global" | "unknown";
};

const AGENT_PAD = 10;
const KIND_PAD = 6;
const TOKENS_PAD = 20;

const formatKTokens = (value: number) => `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

const colorByPct = (label: string, pct: number | null, rich: boolean) => {
  if (!rich || pct === null) {
    return label;
  }
  if (pct >= 95) {
    return theme.error(label);
  }
  if (pct >= 80) {
    return theme.warn(label);
  }
  if (pct >= 60) {
    return theme.success(label);
  }
  return theme.muted(label);
};

const formatTokensCell = (
  total: number | undefined,
  contextTokens: number | null,
  rich: boolean,
) => {
  if (total === undefined) {
    const ctxLabel = contextTokens ? formatKTokens(contextTokens) : "?";
    const label = `unknown/${ctxLabel} (?%)`;
    return rich ? theme.muted(label.padEnd(TOKENS_PAD)) : label.padEnd(TOKENS_PAD);
  }
  const totalLabel = formatKTokens(total);
  const ctxLabel = contextTokens ? formatKTokens(contextTokens) : "?";
  const pct = contextTokens ? Math.min(999, Math.round((total / contextTokens) * 100)) : null;
  const label = `${totalLabel}/${ctxLabel} (${pct ?? "?"}%)`;
  const padded = label.padEnd(TOKENS_PAD);
  return colorByPct(padded, pct, rich);
};

const formatKindCell = (kind: SessionRow["kind"], rich: boolean) => {
  const label = kind.padEnd(KIND_PAD);
  if (!rich) {
    return label;
  }
  if (kind === "group") {
    return theme.accentBright(label);
  }
  if (kind === "global") {
    return theme.warn(label);
  }
  if (kind === "direct") {
    return theme.accent(label);
  }
  return theme.muted(label);
};

export async function sessionsCommand(
  opts: {
    json?: boolean;
    store?: string;
    active?: string;
    agent?: string;
    allAgents?: boolean;
    explain?: string;
  },
  runtime: RuntimeEnv,
) {
  const aggregateAgents = opts.allAgents === true;
  const cfg = loadConfig();
  const displayDefaults = resolveSessionDisplayDefaults(cfg);
  const configContextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(displayDefaults.model) ??
    DEFAULT_CONTEXT_TOKENS;
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    },
    runtime,
  });
  if (!targets) {
    return;
  }

  if (opts.explain) {
    const initialStore = opts.store ? loadSessionStore(opts.store) : undefined;
    const target = resolveGatewaySessionStoreTarget({
      cfg,
      key: opts.explain,
      ...(initialStore ? { store: initialStore } : {}),
    });
    const resolvedStorePath = opts.store ?? target.storePath;
    const store = initialStore ?? loadSessionStore(target.storePath);
    const matchedKey = target.storeKeys.find((key) => store[key]);
    const entry = matchedKey ? store[matchedKey] : undefined;
    if (!entry) {
      runtime.error(`Session not found: ${opts.explain}`);
      runtime.exit(1);
      return;
    }

    const defaults = resolveSessionModelRef(cfg, undefined, target.agentId);
    const resolved = resolveSessionModelRef(cfg, entry, target.agentId);
    const workspaceDir = entry.spawnedWorkspaceDir ?? resolveAgentWorkspaceDir(cfg, target.agentId);
    const delivery = deliveryContextFromSession(entry);
    const effectiveTools = resolveEffectiveToolInventory({
      cfg,
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
      workspaceDir,
      messageProvider: delivery?.channel ?? entry.lastChannel ?? entry.channel ?? entry.origin?.provider,
      modelProvider: resolved.provider,
      modelId: resolved.model,
      currentChannelId: delivery?.to,
      currentThreadTs:
        delivery?.threadId != null
          ? String(delivery.threadId)
          : entry.lastThreadId != null
            ? String(entry.lastThreadId)
            : entry.origin?.threadId != null
              ? String(entry.origin.threadId)
              : undefined,
      accountId: delivery?.accountId ?? entry.lastAccountId ?? entry.origin?.accountId,
      groupId: entry.groupId,
      groupChannel: entry.groupChannel,
      groupSpace: entry.space,
      replyToMode: resolveReplyToMode(
        cfg,
        delivery?.channel ?? entry.lastChannel ?? entry.channel ?? entry.origin?.provider,
        delivery?.accountId ?? entry.lastAccountId ?? entry.origin?.accountId,
        entry.chatType ?? entry.origin?.chatType,
      ),
    });
    const payload = {
      key: target.canonicalKey,
      agentId: target.agentId,
      storePath: resolvedStorePath,
      defaults,
      input: {
        providerOverride: entry.providerOverride ?? null,
        modelOverride: entry.modelOverride ?? null,
        runtimeProvider: entry.modelProvider ?? null,
        runtimeModel: entry.model ?? null,
        spawnedWorkspaceDir: entry.spawnedWorkspaceDir ?? null,
      },
      resolved: {
        provider: resolved.provider,
        model: resolved.model,
        workspaceDir,
      },
      resolution: {
        defaultModelRef: `${defaults.provider}/${defaults.model}`,
        usesPersistedWorkspace: Boolean(entry.spawnedWorkspaceDir),
        usesRuntimeModelRef: Boolean(entry.modelProvider || entry.model),
        usesOverrides: Boolean(entry.providerOverride || entry.modelOverride),
      },
      tools: {
        profile: effectiveTools.profile,
        groups: effectiveTools.groups.map((group) => ({
          id: group.id,
          label: group.label,
          count: group.tools.length,
          tools: group.tools.slice(0, 8).map((tool) => tool.id),
        })),
      },
    };

    if (opts.json) {
      writeRuntimeJson(runtime, payload);
      return;
    }

    const rich = isRich();
    const label = (value: string) => (rich ? theme.accent(value.padEnd(24)) : value.padEnd(24));
    const muted = (value: string) => (rich ? theme.muted(value) : value);
    const infoLabel = (value: string) => (rich ? theme.info(value) : value);
    const success = (value: string) => (rich ? theme.success(value) : value);

    runtime.log(`${label("Session key")}${muted(": ")}${infoLabel(payload.key)}`);
    runtime.log(`${label("Agent")}${muted(": ")}${infoLabel(payload.agentId)}`);
    runtime.log(`${label("Store path")}${muted(": ")}${muted(payload.storePath)}`);
    runtime.log(
      `${label("Default resolved")}${muted(": ")}${infoLabel(`${payload.defaults.provider}/${payload.defaults.model}`)}`,
    );
    runtime.log(
      `${label("Provider override")}${muted(": ")}${infoLabel(payload.input.providerOverride ?? "-")}`,
    );
    runtime.log(
      `${label("Model override")}${muted(": ")}${infoLabel(payload.input.modelOverride ?? "-")}`,
    );
    runtime.log(
      `${label("Runtime model ref")}${muted(": ")}${infoLabel(`${payload.input.runtimeProvider ?? "-"}/${payload.input.runtimeModel ?? "-"}`)}`,
    );
    runtime.log(
      `${label("Persisted workspace")}${muted(": ")}${infoLabel(payload.input.spawnedWorkspaceDir ?? "-")}`,
    );
    runtime.log(
      `${label("Uses overrides")}${muted(": ")}${payload.resolution.usesOverrides ? success("yes") : muted("no")}`,
    );
    runtime.log(
      `${label("Uses runtime ref")}${muted(": ")}${payload.resolution.usesRuntimeModelRef ? success("yes") : muted("no")}`,
    );
    runtime.log(
      `${label("Uses persisted ws")}${muted(": ")}${payload.resolution.usesPersistedWorkspace ? success("yes") : muted("no")}`,
    );
    runtime.log(
      `${label("Final model")}${muted(": ")}${success(`${payload.resolved.provider}/${payload.resolved.model}`)}`,
    );
    runtime.log(`${label("Final workspace")}${muted(": ")}${success(payload.resolved.workspaceDir)}`);
    runtime.log(`${label("Tools profile")}${muted(": ")}${infoLabel(payload.tools.profile)}`);
    for (const group of payload.tools.groups) {
      runtime.log(
        `${label(`Tools ${group.id}`)}${muted(": ")}${infoLabel(`${group.count} [${group.tools.join(", ")}]`)}`,
      );
    }
    return;
  }

  let activeMinutes: number | undefined;
  if (opts.active !== undefined) {
    const parsed = Number.parseInt(String(opts.active), 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      runtime.error("--active must be a positive integer (minutes)");
      runtime.exit(1);
      return;
    }
    activeMinutes = parsed;
  }

  const rows = targets
    .flatMap((target) => {
      const store = loadSessionStore(target.storePath);
      return toSessionDisplayRows(store).map((row) => ({
        ...row,
        agentId: parseAgentSessionKey(row.key)?.agentId ?? target.agentId,
        kind: classifySessionKey(row.key, store[row.key]),
      }));
    })
    .filter((row) => {
      if (activeMinutes === undefined) {
        return true;
      }
      if (!row.updatedAt) {
        return false;
      }
      return Date.now() - row.updatedAt <= activeMinutes * 60_000;
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  if (opts.json) {
    const multi = targets.length > 1;
    const aggregate = aggregateAgents || multi;
    writeRuntimeJson(runtime, {
      path: aggregate ? null : (targets[0]?.storePath ?? null),
      stores: aggregate
        ? targets.map((target) => ({
            agentId: target.agentId,
            path: target.storePath,
          }))
        : undefined,
      allAgents: aggregateAgents ? true : undefined,
      count: rows.length,
      activeMinutes: activeMinutes ?? null,
      sessions: rows.map((r) => {
        const model = resolveSessionDisplayModel(cfg, r, displayDefaults);
        return {
          ...r,
          totalTokens: resolveFreshSessionTotalTokens(r) ?? null,
          totalTokensFresh:
            typeof r.totalTokens === "number" ? r.totalTokensFresh !== false : false,
          contextTokens:
            r.contextTokens ?? lookupContextTokens(model) ?? configContextTokens ?? null,
          model,
        };
      }),
    });
    return;
  }

  if (targets.length === 1 && !aggregateAgents) {
    runtime.log(info(`Session store: ${targets[0]?.storePath}`));
  } else {
    runtime.log(
      info(`Session stores: ${targets.length} (${targets.map((t) => t.agentId).join(", ")})`),
    );
  }
  runtime.log(info(`Sessions listed: ${rows.length}`));
  if (activeMinutes) {
    runtime.log(info(`Filtered to last ${activeMinutes} minute(s)`));
  }
  if (rows.length === 0) {
    runtime.log("No sessions found.");
    return;
  }

  const rich = isRich();
  const showAgentColumn = aggregateAgents || targets.length > 1;
  const header = [
    ...(showAgentColumn ? ["Agent".padEnd(AGENT_PAD)] : []),
    "Kind".padEnd(KIND_PAD),
    "Key".padEnd(SESSION_KEY_PAD),
    "Age".padEnd(SESSION_AGE_PAD),
    "Model".padEnd(SESSION_MODEL_PAD),
    "Tokens (ctx %)".padEnd(TOKENS_PAD),
    "Flags",
  ].join(" ");

  runtime.log(rich ? theme.heading(header) : header);

  for (const row of rows) {
    const model = resolveSessionDisplayModel(cfg, row, displayDefaults);
    const contextTokens = row.contextTokens ?? lookupContextTokens(model) ?? configContextTokens;
    const total = resolveFreshSessionTotalTokens(row);

    const line = [
      ...(showAgentColumn
        ? [rich ? theme.accentBright(row.agentId.padEnd(AGENT_PAD)) : row.agentId.padEnd(AGENT_PAD)]
        : []),
      formatKindCell(row.kind, rich),
      formatSessionKeyCell(row.key, rich),
      formatSessionAgeCell(row.updatedAt, rich),
      formatSessionModelCell(model, rich),
      formatTokensCell(total, contextTokens ?? null, rich),
      formatSessionFlagsCell(row, rich),
    ].join(" ");

    runtime.log(line.trimEnd());
  }
}
