import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
} from "../../agents/auth-health.js";
import {
  ensureAuthProfileStore,
  resolveAuthStorePathForDisplay,
  resolveProfileUnusableUntilForDisplay,
} from "../../agents/auth-profiles.js";
import { loadConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { renderTable } from "../../terminal/table.js";
import { colorize, theme } from "../../terminal/theme.js";
import { shortenHomePath } from "../../utils.js";
import { resolveKnownAgentId } from "./shared.js";

function statusLabel(rich: boolean, status: string): string {
  if (status === "ok") {
    return colorize(rich, theme.success, "ok");
  }
  if (status === "expiring") {
    return colorize(rich, theme.warn, "expiring");
  }
  if (status === "static") {
    return colorize(rich, theme.muted, "static");
  }
  if (status === "missing") {
    return colorize(rich, theme.warn, "unknown");
  }
  return colorize(rich, theme.error, "expired");
}

function fmtDurationMs(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "-";
  }
  if (ms <= 0) {
    return "0m";
  }
  return formatRemainingShort(ms, { underMinuteLabel: "<1m" });
}

export async function modelsAuthStatusCommand(
  opts: {
    json?: boolean;
    plain?: boolean;
    agent?: string;
    warnAfterMs?: string;
  },
  runtime: RuntimeEnv,
) {
  const cfg = loadConfig();
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
  const agentDir = agentId ? resolveAgentDir(cfg, agentId) : resolveOpenClawAgentDir();
  const store = ensureAuthProfileStore(agentDir);

  const warnAfterMs = opts.warnAfterMs ? Number(opts.warnAfterMs) : DEFAULT_OAUTH_WARN_MS;
  if (!Number.isFinite(warnAfterMs) || warnAfterMs <= 0) {
    throw new Error("--warn-after-ms must be a positive number.");
  }

  const summary = buildAuthHealthSummary({
    store,
    cfg,
    warnAfterMs,
  });

  const rowsRaw = summary.profiles.map((p) => {
    const unusableUntil = resolveProfileUnusableUntilForDisplay(store, p.profileId);
    const cooldownMs =
      typeof unusableUntil === "number" && Number.isFinite(unusableUntil)
        ? Math.max(0, unusableUntil - Date.now())
        : undefined;
    return {
      profileId: p.profileId,
      provider: p.provider,
      type: p.type,
      status: p.status,
      expiresIn: p.status === "static" ? "-" : fmtDurationMs(p.remainingMs),
      cooldown: fmtDurationMs(cooldownMs),
      source: p.source,
    };
  });

  if (opts.json) {
    runtime.logJson({
      agentDir,
      authStore: resolveAuthStorePathForDisplay(agentDir),
      defaultModel: cfg.agents?.defaults?.model?.primary ?? null,
      warnAfterMs,
      rows: rowsRaw,
    });
    return;
  }

  if (opts.plain) {
    for (const row of rowsRaw) {
      runtime.log(
        [
          row.profileId,
          row.provider,
          row.type,
          row.status,
          row.expiresIn,
          row.cooldown,
          row.source,
        ].join("\t"),
      );
    }
    return;
  }

  const rich = runtime.isTTY;
  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);

  runtime.log(
    `${colorize(rich, theme.muted, "Auth store")}: ${colorize(
      rich,
      theme.info,
      shortenHomePath(resolveAuthStorePathForDisplay(agentDir)),
    )}`,
  );
  runtime.log(
    `${colorize(rich, theme.muted, "Profiles")}: ${colorize(rich, theme.info, String(rowsRaw.length))}`,
  );
  runtime.log("");

  const rows = rowsRaw.map((r) => ({
    Profile: colorize(rich, theme.accent, r.profileId),
    Provider: r.provider,
    Type: r.type,
    Status: statusLabel(rich, r.status),
    Expires: r.expiresIn,
    Cooldown: r.cooldown,
    Source: r.source,
  }));

  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Profile", header: "Profile", minWidth: 26 },
        { key: "Provider", header: "Provider", minWidth: 14 },
        { key: "Type", header: "Type", minWidth: 8 },
        { key: "Status", header: "Status", minWidth: 10 },
        { key: "Expires", header: "Expires", minWidth: 8 },
        { key: "Cooldown", header: "Cooldown", minWidth: 9 },
        { key: "Source", header: "Source", minWidth: 8 },
      ],
      rows,
    }).trimEnd(),
  );
}
