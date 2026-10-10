// Runtime implementations for `openclaw plugins` subcommands. Heavy plugin modules stay
// lazy-loaded so the base CLI can start without activating the plugin registry.
import type { PluginsRefreshResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { resolveConfiguredRuntimePluginInstallCandidate } from "../commands/doctor/shared/configured-runtime-plugin-installs.js";
import { collectConfiguredRuntimePluginIds } from "../commands/doctor/shared/configured-runtime-plugin-owners.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  getRuntimeConfig,
  readConfigFileSnapshot,
} from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitDiagnosticsTimelineEvent } from "../infra/diagnostics-timeline.js";
import { resolvePluginInstallSources } from "../plugins/install-channel-specs.js";
import type {
  HostedOfficialExternalPluginCatalogLoadResult,
  HostedOfficialExternalPluginCatalogTrustState,
  OfficialExternalPluginCatalogEntry,
  OfficialExternalPluginCatalogFeed,
} from "../plugins/official-external-plugin-catalog.types.js";
import type { PluginPackageInstall } from "../plugins/package-manifest.types.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { tracePluginLifecyclePhaseAsync } from "../plugins/plugin-lifecycle-trace.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { formatMissingPluginMessage } from "./error-format.js";
import { formatCliJsonFailure } from "./failure-output.js";
import { exitCliAfterOutput } from "./one-shot-exit.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import type {
  PluginDoctorOptions,
  PluginMarketplaceEntriesOptions,
  PluginMarketplaceRefreshOptions,
  PluginRegistryOptions,
} from "./plugins-cli.js";
import type { RunPluginInstallCommandParams } from "./plugins-install-preflight.js";

type PluginInstallActionOptions = RunPluginInstallCommandParams["opts"];

function countEnabledPlugins(plugins: readonly { enabled: boolean }[]): number {
  return plugins.filter((plugin) => plugin.enabled).length;
}

function reportMissingPlugin(id: string) {
  defaultRuntime.error(formatMissingPluginMessage({ id, includeSearch: true }));
  return defaultRuntime.exit(1);
}

function isConfigSelectedShadowDiagnostic(entry: { level?: string; message?: string }): boolean {
  return (
    (entry.level === "info" || entry.level === "warn") &&
    typeof entry.message === "string" &&
    entry.message.includes("duplicate plugin id resolved by explicit config-selected plugin")
  );
}

function collectConfiguredRuntimePluginWarnings(params: {
  cfg: OpenClawConfig;
  plugins: readonly { enabled?: boolean; id: string; status?: string }[];
}): string[] {
  const enabledPluginIds = new Set(
    params.plugins
      .filter((plugin) => plugin.enabled !== false && plugin.status !== "disabled")
      .map((plugin) => plugin.id),
  );
  return collectConfiguredRuntimePluginIds(params.cfg, {
    includeImplicitRuntimePreferences: false,
  }).flatMap((pluginId) => {
    const candidate = resolveConfiguredRuntimePluginInstallCandidate(pluginId);
    if (!candidate || enabledPluginIds.has(pluginId)) {
      return [];
    }
    const disabledPluginRecord = params.plugins.find((plugin) => plugin.id === pluginId);
    const policy = params.cfg.plugins;
    const prefix = `- Configured runtime "${pluginId}" requires the ${candidate.label} plugin`;
    const alternative =
      pluginId === "acpx"
        ? "disable ACP/acpx in acp config"
        : 'change the runtime policy to "openclaw"';
    let blockedGuidance: string | undefined;
    if (policy?.enabled === false) {
      blockedGuidance = `Enable plugin loading and the "${pluginId}" plugin, or ${alternative}.`;
    } else if (
      Array.isArray(policy?.deny) &&
      policy.deny.some((entry) => entry.trim() === pluginId)
    ) {
      blockedGuidance = `Remove "${pluginId}" from plugins.deny and enable the "${pluginId}" plugin, or ${alternative}.`;
    } else if (policy?.entries?.[pluginId]?.enabled === false) {
      blockedGuidance = `Set plugins.entries.${pluginId}.enabled=true or remove that disabled entry, or ${alternative}.`;
    }
    if (blockedGuidance) {
      return [
        `${prefix}, but "${pluginId}" is blocked by plugin configuration. ${blockedGuidance}`,
      ];
    }
    if (disabledPluginRecord) {
      const allow = policy?.allow;
      const guidance =
        Array.isArray(allow) && allow.length > 0 && !allow.includes(pluginId)
          ? `Add "${pluginId}" to plugins.allow and enable the plugin, or ${alternative}.`
          : `Enable the "${pluginId}" plugin, or ${alternative}.`;
      return [`${prefix}, but "${pluginId}" is disabled. ${guidance}`];
    }
    const installSpec = resolvePluginInstallSources(candidate)[0]?.spec ?? candidate.pluginId;
    return [
      `${prefix}, but no enabled "${pluginId}" plugin was found. Run "openclaw doctor --fix" to install ${installSpec}, or install it manually with "openclaw plugins install ${installSpec}".`,
    ];
  });
}

async function applyPluginEnabledThroughGateway(
  pluginId: string,
  enabled: boolean,
  opts: { acceptCapabilities?: boolean } = {},
): Promise<boolean> {
  const { resolvePluginLifecycleGateway } = await import("./plugins-lifecycle-client.js");
  const gateway = await resolvePluginLifecycleGateway();
  if (!gateway) {
    return false;
  }
  const consent = resolvePluginCapabilityConsentCliOptions({ ...opts, action: "enable" });
  const result = await gateway<{ plugin: { id: string }; warnings?: string[] }>(
    "plugins.setEnabled",
    { pluginId, enabled, ...(enabled ? { allowlistPolicy: "preserve" } : {}) },
    consent.onCapabilityConsent,
  );
  for (const warning of result.warnings ?? []) {
    defaultRuntime.log(theme.warn(warning));
  }
  defaultRuntime.log(`${enabled ? "Enabled" : "Disabled"} plugin "${result.plugin.id}".`);
  return true;
}

export async function runPluginsEnableCommand(
  id: string,
  opts: { acceptCapabilities?: boolean } = {},
): Promise<void> {
  await runPluginPolicyCommand(id, true, opts.acceptCapabilities);
}

export async function runPluginsDisableCommand(id: string): Promise<void> {
  await runPluginPolicyCommand(id, false);
}

async function runPluginPolicyCommand(
  id: string,
  enabled: boolean,
  acceptCapabilities?: boolean,
): Promise<void> {
  assertConfigWriteAllowedInCurrentMode();
  if (await applyPluginEnabledThroughGateway(id, enabled, { acceptCapabilities })) {
    return;
  }
  const { mutateManagedPluginEnabled } = await import("../plugins/management-mutations.js");
  const { ManagedPluginLifecycleError } = await import("../plugins/management-lifecycle-error.js");
  await withPluginLifecycleLease({}, async () => {
    try {
      const result = await mutateManagedPluginEnabled({
        pluginId: id,
        enabled,
        caller: "cli",
        requestCapabilityConsent: acceptCapabilities,
        ...resolvePluginCapabilityConsentCliOptions({ acceptCapabilities, action: "enable" }),
      });
      if (result.status === "missing") {
        return reportMissingPlugin(result.pluginId);
      }
      if (result.status === "blocked") {
        defaultRuntime.error(
          `Plugin "${result.pluginId}" could not be enabled (${result.reason ?? "unknown reason"}).`,
        );
        return defaultRuntime.exit(1);
      }
      for (const warning of result.warnings) {
        defaultRuntime.log(theme.warn(warning));
      }
      defaultRuntime.log(
        `${enabled ? "Enabled" : "Disabled"} plugin "${result.pluginId}". Saved for the next Gateway start.`,
      );
    } catch (error) {
      if (!(error instanceof ManagedPluginLifecycleError) || !error.capabilityConsent) {
        throw error;
      }
      defaultRuntime.error(error.message);
      return defaultRuntime.exit(1);
    }
  });
}

export async function runPluginsInstallAction(
  raw: string,
  opts: PluginInstallActionOptions,
): Promise<void> {
  await tracePluginLifecyclePhaseAsync(
    "install command",
    async () => {
      const { runPluginInstallCommand } = await import("./plugins-install-command.js");
      await runPluginInstallCommand({
        raw,
        opts,
        allowInstallPolicyWarningPrompt: true,
        invalidateRuntimeCache: false,
      });
    },
    { command: "install" },
  );
}

export async function runPluginsRegistryCommand(opts: PluginRegistryOptions): Promise<void> {
  const { inspectPluginRegistry } = await import("../plugins/plugin-registry.js");

  const formatDifferences = (
    differences: Awaited<ReturnType<typeof inspectPluginRegistry>>["differences"],
  ) => {
    const formatSource = (source: string | null) =>
      source ? sanitizeTerminalText(shortenHomePath(source)) : "missing";
    return differences.map(
      (difference) =>
        `${sanitizeTerminalText(difference.pluginId)}: ${difference.changed.join("+")} changed; persisted ${formatSource(difference.persistedSource)}; derived ${formatSource(difference.derivedSource)}`,
    );
  };

  if (opts.refresh) {
    const { refreshPluginRegistry } = await import("../plugins/plugin-registry-refresh.js");
    return await withPluginLifecycleLease({}, async () => {
      const config = getRuntimeConfig();
      const index = await refreshPluginRegistry({
        config,
        reason: "manual",
      });
      const inspection = await inspectPluginRegistry({ config });
      if (inspection.state !== "fresh") {
        const differenceLines = formatDifferences(inspection.differences);
        const message = [
          "Plugin registry refresh could not verify the persisted replacement.",
          ...differenceLines.map((difference) => `- ${difference}`),
          "Stop plugin package changes, then run `openclaw plugins registry --refresh` again.",
        ].join("\n");
        if (opts.json) {
          defaultRuntime.writeJson({
            ...formatCliJsonFailure(message),
            refreshed: false,
            state: inspection.state,
            refreshReasons: inspection.refreshReasons,
            differences: inspection.differences,
          });
          exitCliAfterOutput(defaultRuntime, 1);
        }
        throw new Error(message);
      }
      if (opts.json) {
        defaultRuntime.writeJson({
          refreshed: true,
          state: inspection.state,
          refreshReasons: inspection.refreshReasons,
          differences: inspection.differences,
          registry: index,
        });
        return;
      }
      const total = index.plugins.length;
      const enabled = countEnabledPlugins(index.plugins);
      defaultRuntime.log(`Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`);
    });
  }

  const inspection = await inspectPluginRegistry({ config: getRuntimeConfig() });
  if (opts.json) {
    defaultRuntime.writeJson({
      state: inspection.state,
      refreshReasons: inspection.refreshReasons,
      differences: inspection.differences,
      persisted: inspection.persisted,
      current: inspection.current,
    });
    return;
  }

  const currentTotal = inspection.current.plugins.length;
  const currentEnabled = countEnabledPlugins(inspection.current.plugins);
  const persistedTotal = inspection.persisted?.plugins.length ?? 0;
  const persistedEnabled = inspection.persisted
    ? countEnabledPlugins(inspection.persisted.plugins)
    : 0;
  const lines = [
    `${theme.muted("State:")} ${inspection.state === "fresh" ? theme.success(inspection.state) : theme.warn(inspection.state)}`,
    `${theme.muted("Current:")} ${currentEnabled}/${currentTotal} enabled plugins`,
    `${theme.muted("Persisted:")} ${persistedEnabled}/${persistedTotal} enabled plugins`,
  ];
  if (inspection.refreshReasons.length > 0) {
    lines.push(`${theme.muted("Refresh reasons:")} ${inspection.refreshReasons.join(", ")}`);
    lines.push(...formatDifferences(inspection.differences).map((difference) => `- ${difference}`));
    lines.push(`${theme.muted("Repair:")} ${theme.command("openclaw plugins registry --refresh")}`);
  }
  defaultRuntime.log(lines.join("\n"));
}

export async function runPluginsDoctorCommand(opts: PluginDoctorOptions = {}): Promise<void> {
  const {
    buildPluginCompatibilityNotices,
    withPluginDiagnosticsReportForInspection,
    formatPluginCompatibilityNotice,
  } = await import("../plugins/status.js");
  const {
    collectStalePluginConfigWarnings,
    isStalePluginAutoRepairBlocked,
    scanStalePluginConfig,
  } = await import("../commands/doctor/shared/stale-plugin-config.js");
  const cfg = getRuntimeConfig();
  const configSnapshot = await readConfigFileSnapshot().catch(() => null);
  const sourceCfg = configSnapshot?.sourceConfig ?? configSnapshot?.config ?? cfg;
  let exitCode = 1;
  const output = await withPluginDiagnosticsReportForInspection(
    { config: cfg, effectiveOnly: true },
    (report) => {
      const errors = report.plugins.filter((p) => p.status === "error");
      const diags = report.diagnostics.filter((entry) => !isConfigSelectedShadowDiagnostic(entry));
      const shadowed = report.diagnostics.filter(
        (entry) =>
          entry.pluginId &&
          isConfigSelectedShadowDiagnostic(entry) &&
          report.plugins.some(
            (plugin) =>
              plugin.id === entry.pluginId &&
              plugin.origin === "config" &&
              plugin.status === "error",
          ),
      );
      const compatibility = buildPluginCompatibilityNotices({ report });
      const pluginConfigWarnings = new Set([
        ...formatConfigIssueLines(
          (configSnapshot?.warnings ?? []).filter(
            ({ path }) => path === "plugins" || path.startsWith("plugins."),
          ),
        ),
        ...collectStalePluginConfigWarnings({
          hits: scanStalePluginConfig(sourceCfg, process.env),
          doctorFixCommand: "openclaw doctor --fix",
          autoRepairBlocked: isStalePluginAutoRepairBlocked(sourceCfg, process.env),
        }),
        ...collectConfiguredRuntimePluginWarnings({ cfg: sourceCfg, plugins: report.plugins }),
      ]);
      const hasInstallTreeIssues =
        [errors, diags, shadowed].some(({ length }) => length > 0) ||
        compatibility.some(({ severity }) => severity === "warn");
      const doctorOk = !hasInstallTreeIssues && pluginConfigWarnings.size === 0;
      exitCode = doctorOk ? 0 : 1;

      if (opts.json) {
        return JSON.stringify(
          {
            ok: doctorOk,
            pluginErrors: errors.map((entry) => ({
              id: entry.id,
              ...(entry.failurePhase ? { failurePhase: entry.failurePhase } : {}),
              error: shortenHomeInString(entry.error ?? "failed to load"),
              source: shortenHomePath(entry.source),
            })),
            diagnostics: diags.map(({ message, source, ...diagnostic }) => ({
              ...diagnostic,
              message: shortenHomeInString(message),
              ...(source ? { source: shortenHomePath(source) } : {}),
            })),
            sourceShadowing: shadowed.map((entry) => {
              const active = report.plugins.find((plugin) => plugin.id === entry.pluginId);
              return {
                ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
                message: shortenHomeInString(entry.message),
                ...(active
                  ? {
                      active: {
                        source: shortenHomePath(active.source),
                        origin: active.origin,
                        status: active.status,
                        ...(active.error ? { error: shortenHomeInString(active.error) } : {}),
                      },
                    }
                  : {}),
                ...(entry.source ? { shadowedSource: shortenHomePath(entry.source) } : {}),
                repair: [
                  `openclaw plugins inspect ${entry.pluginId ?? "<plugin-id>"}`,
                  "edit or remove the config-selected plugin source",
                  "openclaw plugins registry --refresh",
                  `openclaw plugins reload ${entry.pluginId ?? "<plugin-id>"}`,
                ],
              };
            }),
            compatibility: compatibility.map((notice) => ({
              ...notice,
              message: shortenHomeInString(notice.message),
            })),
            configurationWarnings: Array.from(pluginConfigWarnings, shortenHomeInString),
          },
          null,
          2,
        );
      }

      const healthyMessage =
        "Plugin discovery, module loading, compatibility, and configuration checks passed. " +
        'Run "openclaw health" to check the running Gateway, including runtime quarantines and fallbacks.';
      if (!hasInstallTreeIssues && pluginConfigWarnings.size === 0 && compatibility.length === 0) {
        return healthyMessage;
      }

      const lines: string[] = [];
      const appendSection = (title: string, content: string[]) => {
        if (content.length > 0) {
          if (lines.length > 0) {
            lines.push("");
          }
          lines.push(title, ...content);
        }
      };
      appendSection(
        theme.error("Plugin errors:"),
        errors.map((entry) => {
          const phase = entry.failurePhase ? ` [${entry.failurePhase}]` : "";
          return `- ${entry.id}${phase}: ${entry.error ?? "failed to load"} (${entry.source})`;
        }),
      );
      appendSection(
        theme.warn("Diagnostics:"),
        diags.map((diag) => {
          const target = diag.pluginId ? `${diag.pluginId}: ` : "";
          return `- ${target}${diag.message}`;
        }),
      );
      appendSection(
        theme.warn("Plugin source shadowing:"),
        shadowed.flatMap((diag) => {
          const active = report.plugins.find((plugin) => plugin.id === diag.pluginId);
          const target = diag.pluginId ? `${diag.pluginId}: ` : "";
          const details = [`- ${target}${diag.message}`];
          if (active) {
            details.push(`  active: ${shortenHomePath(active.source)} (${active.origin})`);
            if (active.status === "error") {
              details.push(`  active status: error${active.error ? `: ${active.error}` : ""}`);
            }
          }
          if (diag.source) {
            details.push(`  shadowed: ${shortenHomePath(diag.source)}`);
          }
          details.push(
            "  repair:",
            "    openclaw plugins inspect " + (diag.pluginId ?? "<plugin-id>"),
            "    edit or remove the config-selected plugin source",
            "    openclaw plugins registry --refresh",
            "    openclaw plugins reload " + (diag.pluginId ?? "<plugin-id>"),
          );
          return details;
        }),
      );
      appendSection(
        theme.warn("Compatibility:"),
        compatibility.map((notice) => {
          const marker = notice.severity === "warn" ? theme.warn("warn") : theme.muted("info");
          return `- ${formatPluginCompatibilityNotice(notice)} [${marker}]`;
        }),
      );
      appendSection(theme.warn("Plugin configuration:"), [...pluginConfigWarnings]);
      if (!hasInstallTreeIssues) {
        const summary = pluginConfigWarnings.size
          ? "No plugin install-tree issues detected; configuration warnings remain."
          : healthyMessage;
        lines.push("", summary);
      }
      const docs = formatDocsLink("/plugin", "docs.openclaw.ai/plugin");
      lines.push("");
      lines.push(`${theme.muted("Docs:")} ${docs}`);
      return lines.join("\n");
    },
  );
  process.exitCode = exitCode;
  if (opts.json) {
    defaultRuntime.writeStdout(output);
  } else {
    defaultRuntime.log(output);
  }
}

type MarketplaceRefreshPayload = Pick<
  HostedOfficialExternalPluginCatalogLoadResult,
  "source" | "metadata"
> & {
  entries: number;
  feed?: Pick<OfficialExternalPluginCatalogFeed, "id" | "generatedAt" | "sequence">;
  snapshot?: {
    savedAt: string;
  };
  trust?: HostedOfficialExternalPluginCatalogTrustState;
  error?: string;
};

type MarketplaceEntryPayload = Pick<
  OfficialExternalPluginCatalogEntry,
  "id" | "kind" | "name" | "version"
> & {
  label: string;
  install?: PluginPackageInstall;
};

type MarketplaceFeedTelemetryOptions = {
  expectedSha256?: string;
  feedProfile?: string;
  feedUrl?: string;
  offline?: boolean;
};

function classifyMarketplaceFeedFallback(error: string | undefined): string | undefined {
  const text = error?.toLowerCase();
  if (!text) {
    return undefined;
  }
  const categories = [
    [/offline mode/u, "offline"],
    [/checksum mismatch/u, "checksum_mismatch"],
    [/schema/u, "schema"],
    [/http\s+304/u, "not_modified"],
    [/http\s+\d{3}/u, "http_error"],
    [/timed out|timeout/u, "timeout"],
  ] as const;
  return categories.find(([pattern]) => pattern.test(text))?.[1] ?? "error";
}

function emitMarketplaceFeedTelemetry(params: {
  command: "entries" | "refresh";
  failedPinnedRefresh?: boolean;
  opts: MarketplaceFeedTelemetryOptions;
  config?: OpenClawConfig;
  payload: MarketplaceRefreshPayload;
}): void {
  const attributes: Record<string, string | number | boolean | null> = {
    command: params.command,
    entries: params.payload.entries,
    source: params.payload.source,
  };
  if (params.opts.feedProfile?.trim()) {
    attributes.feedProfileProvided = true;
  }
  if (params.opts.feedUrl?.trim()) {
    attributes.feedUrlOverride = true;
  }
  if (params.opts.offline === true) {
    attributes.offline = true;
  }
  if (params.opts.expectedSha256?.trim()) {
    attributes.expectedSha256Provided = true;
  }
  if (params.payload.feed) {
    attributes.feedIdPresent = true;
    attributes.feedSequence = params.payload.feed.sequence;
  }
  if (params.payload.metadata) {
    attributes.httpStatus = params.payload.metadata.status;
    if (params.payload.metadata.checksum) {
      attributes.payloadChecksumPresent = true;
    }
    attributes.hasEtag = Boolean(params.payload.metadata.etag);
    attributes.hasLastModified = Boolean(params.payload.metadata.lastModified);
  }
  if (params.payload.snapshot) {
    attributes.snapshotUsed = true;
  }
  if (params.payload.trust) {
    attributes.feedTrustVerified = true;
    attributes.feedTrustMode = params.payload.trust.mode;
    attributes.feedTrustSignatureCount = params.payload.trust.signatureCount;
    attributes.feedTrustThreshold = params.payload.trust.threshold;
  }
  const fallbackCategory = classifyMarketplaceFeedFallback(params.payload.error);
  if (fallbackCategory) {
    attributes.fallbackCategory = fallbackCategory;
  }
  if (params.failedPinnedRefresh === true) {
    attributes.pinnedRefreshFailed = true;
  }
  emitDiagnosticsTimelineEvent(
    {
      type: "mark",
      name: `plugins.marketplace.feed.${params.command}`,
      phase: "plugin-marketplace",
      attributes,
    },
    {
      config: params.config,
    },
  );
}

function buildMarketplaceRefreshPayload(
  result: HostedOfficialExternalPluginCatalogLoadResult,
  feedUrl?: string,
): MarketplaceRefreshPayload {
  const payload: MarketplaceRefreshPayload = {
    source: result.source,
    entries: result.entries.length,
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
  if (result.source === "hosted" || result.source === "hosted-snapshot") {
    payload.feed = {
      id: result.feed.id,
      generatedAt: result.feed.generatedAt,
      sequence: result.feed.sequence,
    };
    if (result.trust) {
      payload.trust = {
        mode: result.trust.mode,
        signedBy: result.trust.signedBy,
        signatureCount: result.trust.signatureCount,
        threshold: result.trust.threshold,
        verifiedAt: result.trust.verifiedAt,
      };
    }
  }
  if (result.source === "hosted-snapshot") {
    payload.snapshot = { savedAt: result.snapshot.savedAt };
    payload.error = result.error;
  }
  if (result.source === "bundled-fallback") {
    payload.error = result.error;
  }
  const rawMetadataUrl = payload.metadata?.url;
  if (payload.metadata) {
    payload.metadata = { ...payload.metadata, url: redactMarketplaceFeedUrl(payload.metadata.url) };
  }
  if (payload.error) {
    payload.error = redactMarketplaceOutputText(payload.error, [feedUrl, rawMetadataUrl]);
  }
  return payload;
}

function redactMarketplaceFeedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function redactMarketplaceOutputText(
  value: string,
  rawUrls: readonly (string | undefined)[],
): string {
  let redacted = value;
  for (const rawUrl of rawUrls) {
    if (!rawUrl) {
      continue;
    }
    redacted = redacted.replaceAll(rawUrl, () => redactMarketplaceFeedUrl(rawUrl));
  }
  return redacted;
}

function formatMarketplaceEntryLine(entry: MarketplaceEntryPayload): string {
  const id = entry.id ?? entry.name ?? entry.label;
  const install =
    resolvePluginInstallSources(entry.install ?? {})[0]?.spec ?? entry.install?.localPath;
  const suffix = install ? " " + theme.muted(install) : "";
  const label = entry.label !== id ? " " + theme.muted(entry.label) : "";
  return theme.command(id) + label + suffix;
}

function formatMarketplaceRefreshSource(source: MarketplaceRefreshPayload["source"]): string {
  if (source === "hosted") {
    return theme.success("hosted");
  }
  if (source === "hosted-snapshot") {
    return theme.warn("hosted snapshot");
  }
  return theme.warn("bundled fallback");
}

function formatMarketplaceFeedTrust(trust: HostedOfficialExternalPluginCatalogTrustState): string {
  return `${trust.mode} by ${trust.signedBy} (${trust.signatureCount}/${trust.threshold}) verified ${trust.verifiedAt}`;
}

function formatMarketplaceFeedLines(
  payload: MarketplaceRefreshPayload,
  options: { includeChecksum?: boolean } = {},
): string[] {
  const lines = [
    `${theme.muted("Source:")} ${formatMarketplaceRefreshSource(payload.source)}`,
    `${theme.muted("Entries:")} ${payload.entries}`,
  ];
  if (payload.feed) {
    lines.push(
      `${theme.muted("Feed:")} ${payload.feed.id} ${theme.muted(`sequence ${payload.feed.sequence}`)}`,
    );
  }
  if (payload.metadata?.url) {
    lines.push(`${theme.muted("URL:")} ${payload.metadata.url}`);
  }
  if (options.includeChecksum && payload.metadata?.checksum) {
    lines.push(`${theme.muted("SHA-256:")} ${payload.metadata.checksum}`);
  }
  if (payload.snapshot?.savedAt) {
    lines.push(`${theme.muted("Snapshot:")} ${payload.snapshot.savedAt}`);
  }
  if (payload.trust) {
    lines.push(`${theme.muted("Trust:")} ${formatMarketplaceFeedTrust(payload.trust)}`);
  }
  if (payload.error) {
    lines.push(`${theme.muted("Fallback reason:")} ${payload.error}`);
  }
  return lines;
}

function normalizeMarketplaceExpectedSha256(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const hash = /^(?:sha256:)?([0-9a-f]{64})$/iu.exec(trimmed)?.[1];
  return hash ? `sha256:${hash.toLowerCase()}` : trimmed;
}

export async function runPluginMarketplaceEntriesCommand(
  opts: PluginMarketplaceEntriesOptions,
): Promise<void> {
  const catalog = await import("../plugins/official-external-plugin-catalog.js");
  const cfg = getRuntimeConfig();
  const result = await catalog.loadConfiguredHostedOfficialExternalPluginCatalogEntries({
    ...(opts.feedProfile ? { feedProfile: opts.feedProfile } : {}),
    ...(opts.feedUrl ? { feedUrl: opts.feedUrl } : {}),
    ...(opts.offline ? { offline: true } : {}),
  });
  const summary = buildMarketplaceRefreshPayload(result, opts.feedUrl);
  const entries: MarketplaceEntryPayload[] = result.entries.map((entry) => {
    const id = catalog.resolveOfficialExternalPluginId(entry);
    const install = catalog.resolveOfficialExternalPluginInstall(entry) ?? undefined;
    const payload: MarketplaceEntryPayload = {
      label: catalog.resolveOfficialExternalPluginLabel(entry),
    };
    if (id) {
      payload.id = id;
    }
    if (entry.kind) {
      payload.kind = entry.kind;
    }
    if (entry.name) {
      payload.name = entry.name;
    }
    if (entry.version) {
      payload.version = entry.version;
    }
    if (install) {
      payload.install = install;
    }
    return payload;
  });

  emitMarketplaceFeedTelemetry({
    command: "entries",
    opts,
    config: cfg,
    payload: summary,
  });
  if (opts.json) {
    defaultRuntime.writeJson({ ...summary, entries, entryCount: entries.length });
    return;
  }

  const lines = formatMarketplaceFeedLines(summary);
  if (entries.length > 0) {
    lines.push("");
    lines.push(...entries.map(formatMarketplaceEntryLine));
  }
  defaultRuntime.log(lines.join("\n"));
}

export async function runPluginMarketplaceRefreshCommand(
  opts: PluginMarketplaceRefreshOptions,
): Promise<void> {
  const { resolvePluginLifecycleGateway } = await import("./plugins-lifecycle-client.js");
  const gateway = await resolvePluginLifecycleGateway();
  const { loadConfiguredHostedOfficialExternalPluginCatalogEntries } =
    await import("../plugins/official-external-plugin-catalog.js");
  const cfg = getRuntimeConfig();
  const expectedSha256 = normalizeMarketplaceExpectedSha256(opts.expectedSha256);
  const result = await loadConfiguredHostedOfficialExternalPluginCatalogEntries({
    ...(opts.feedProfile ? { feedProfile: opts.feedProfile } : {}),
    ...(opts.feedUrl ? { feedUrl: opts.feedUrl } : {}),
    ...(expectedSha256 ? { expectedSha256 } : {}),
    requireSnapshotWrite: true,
  });
  const { clearManagedPluginCatalogCache } = await import("../plugins/management-catalog.js");
  clearManagedPluginCatalogCache();
  let runtimeNotice: string | undefined;
  let applicationFailure: string | undefined;
  // Reused snapshots can lose install authority as they age; apply the current catalog too.
  if (result.source !== "bundled-fallback") {
    if (gateway) {
      try {
        const applied = await gateway<PluginsRefreshResult>("plugins.refresh", {});
        if (!applied.runtime) {
          throw new Error("Marketplace refresh did not return a runtime application receipt.");
        }
        for (const warning of applied.warnings ?? []) {
          (opts.json ? defaultRuntime.error : defaultRuntime.log)(theme.warn(warning));
        }
        runtimeNotice = `Marketplace catalog applied in Gateway generation ${applied.runtime.generation}.`;
      } catch (error) {
        const message = sanitizeTerminalText(
          error instanceof Error ? error.message : String(error),
        );
        applicationFailure = `Marketplace catalog saved, but Gateway runtime application failed: ${message}. Repair the reported problem, then rerun this refresh.`;
      }
    } else {
      runtimeNotice = "Marketplace catalog saved for the next Gateway start.";
    }
  }
  const payload = buildMarketplaceRefreshPayload(result, opts.feedUrl);

  const failedPinnedRefresh = Boolean(expectedSha256) && payload.source !== "hosted";
  emitMarketplaceFeedTelemetry({
    command: "refresh",
    failedPinnedRefresh,
    opts,
    config: cfg,
    payload,
  });

  if (opts.json) {
    defaultRuntime.writeJson(payload);
    if (!gateway && runtimeNotice) {
      defaultRuntime.error(runtimeNotice);
    }
  } else {
    const lines = formatMarketplaceFeedLines(payload, { includeChecksum: true });
    if (runtimeNotice) {
      lines.push("", runtimeNotice);
    }
    defaultRuntime.log(lines.join("\n"));
  }
  if (applicationFailure) {
    defaultRuntime.error(applicationFailure);
  }
  if (failedPinnedRefresh) {
    defaultRuntime.error(
      `Pinned marketplace feed refresh did not accept a fresh hosted payload (source: ${payload.source}).`,
    );
  }
  if (applicationFailure || failedPinnedRefresh) {
    return defaultRuntime.exit(1);
  }
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
