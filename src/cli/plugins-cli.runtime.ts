// Runtime implementations for `openclaw plugins` subcommands. Heavy plugin modules stay
// lazy-loaded so the base CLI can start without activating the plugin registry.
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  captureRuntimeConfigAsyncReader,
} from "../config/config.js";
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
import { shortenHomePath } from "../utils.js";
import { formatMissingPluginMessage } from "./error-format.js";
import { ExpectedCliError, formatCliJsonFailure } from "./failure-output.js";
import { exitCliAfterOutput } from "./one-shot-exit.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import type {
  PluginDoctorOptions,
  PluginMarketplaceEntriesOptions,
  PluginMarketplaceRefreshOptions,
  PluginRegistryOptions,
} from "./plugins-cli.js";
import type { RunPluginInstallCommandParams } from "./plugins-install-preflight.js";
import { runWithLocalPluginState } from "./plugins-local-state.js";

type PluginInstallActionOptions = RunPluginInstallCommandParams["opts"];

function countEnabledPlugins(plugins: readonly { enabled: boolean }[]): number {
  return plugins.filter((plugin) => plugin.enabled).length;
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
    defaultRuntime.log(theme.warn(terminalText`${warning}`));
  }
  defaultRuntime.log(
    terminalText`${enabled ? "Enabled" : "Disabled"} plugin "${result.plugin.id}".`,
  );
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
  return await runWithLocalPluginState(enabled ? "enable" : "disable", async (assertCurrent) => {
    const { mutateManagedPluginEnabled } = await import("../plugins/management-mutations.js");
    const { ManagedPluginLifecycleError } =
      await import("../plugins/management-lifecycle-error.js");
    await withPluginLifecycleLease({}, async () => {
      try {
        const result = await mutateManagedPluginEnabled({
          pluginId: id,
          enabled,
          caller: "cli",
          beforePersistentApply: assertCurrent,
          requestCapabilityConsent: acceptCapabilities,
          ...resolvePluginCapabilityConsentCliOptions({ acceptCapabilities, action: "enable" }),
        });
        if (result.status === "missing") {
          const message = formatMissingPluginMessage({ id: result.pluginId, includeSearch: true });
          defaultRuntime.error(terminalText`${message}`);
          return defaultRuntime.exit(1);
        }
        if (result.status === "blocked") {
          defaultRuntime.error(
            terminalText`Plugin "${result.pluginId}" could not be enabled (${result.reason ?? "unknown reason"}).`,
          );
          return defaultRuntime.exit(1);
        }
        for (const warning of result.warnings) {
          defaultRuntime.log(theme.warn(terminalText`${warning}`));
        }
        defaultRuntime.log(
          terminalText`${enabled ? "Enabled" : "Disabled"} plugin "${result.pluginId}". Saved for the next Gateway start.`,
        );
      } catch (error) {
        if (!(error instanceof ManagedPluginLifecycleError) || !error.capabilityConsent) {
          throw error;
        }
        defaultRuntime.error(terminalText`${error.message}`);
        return defaultRuntime.exit(1);
      }
    });
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
    return differences.map(
      (difference) =>
        terminalText`${difference.pluginId}: ${difference.changed.join("+")} changed; persisted ${difference.persistedSource ? shortenHomePath(difference.persistedSource) : "missing"}; derived ${difference.derivedSource ? shortenHomePath(difference.derivedSource) : "missing"}`,
    );
  };

  if (opts.refresh) {
    const { refreshPluginRegistry } = await import("../plugins/plugin-registry-refresh.js");
    const refresh = (assertCurrent: () => void) =>
      withPluginLifecycleLease({ assertCurrent }, async (lease) => {
        const config = await captureRuntimeConfigAsyncReader()();
        const index = await refreshPluginRegistry({
          config,
          reason: "manual",
          lease,
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
          throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
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
        defaultRuntime.log(
          `Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`,
        );
      });
    return await runWithLocalPluginState("registry --refresh", refresh);
  }

  const inspection = await inspectPluginRegistry({
    config: await captureRuntimeConfigAsyncReader()(),
  });
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
    lines.push(
      `${theme.muted("Refresh reasons:")} ${terminalText`${inspection.refreshReasons.join(", ")}`}`,
    );
    lines.push(...formatDifferences(inspection.differences).map((difference) => `- ${difference}`));
    lines.push(`${theme.muted("Repair:")} ${theme.command("openclaw plugins registry --refresh")}`);
  }
  defaultRuntime.log(lines.join("\n"));
}

export async function runPluginsDoctorCommand(opts: PluginDoctorOptions = {}): Promise<void> {
  const { collectPluginsDoctorReport } = await import("./plugins-doctor-report.js");
  const { output, exitCode } = await collectPluginsDoctorReport(opts);
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
  const text = params.payload.error?.toLowerCase();
  if (text) {
    const categories = [
      [/offline mode/u, "offline"],
      [/checksum mismatch/u, "checksum_mismatch"],
      [/schema/u, "schema"],
      [/http\s+304/u, "not_modified"],
      [/http\s+\d{3}/u, "http_error"],
      [/timed out|timeout/u, "timeout"],
    ] as const;
    attributes.fallbackCategory =
      categories.find(([pattern]) => pattern.test(text))?.[1] ?? "error";
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
    for (const rawUrl of [feedUrl, rawMetadataUrl]) {
      if (!rawUrl) {
        continue;
      }
      payload.error = payload.error.replaceAll(rawUrl, () => redactMarketplaceFeedUrl(rawUrl));
    }
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

function formatMarketplaceEntryLine(entry: MarketplaceEntryPayload): string {
  const id = entry.id ?? entry.name ?? entry.label;
  const install =
    resolvePluginInstallSources(entry.install ?? {})[0]?.spec ?? entry.install?.localPath;
  const suffix = install ? " " + theme.muted(terminalText`${install}`) : "";
  const label = entry.label !== id ? " " + theme.muted(terminalText`${entry.label}`) : "";
  return theme.command(terminalText`${id}`) + label + suffix;
}

function formatMarketplaceFeedTrust(trust: HostedOfficialExternalPluginCatalogTrustState): string {
  return terminalText`${trust.mode} by ${trust.signedBy} (${trust.signatureCount}/${trust.threshold}) verified ${trust.verifiedAt}`;
}

function formatMarketplaceFeedLines(
  payload: MarketplaceRefreshPayload,
  options: { includeChecksum?: boolean } = {},
): string[] {
  const source =
    payload.source === "hosted"
      ? theme.success("hosted")
      : payload.source === "hosted-snapshot"
        ? theme.warn("hosted snapshot")
        : theme.warn("bundled fallback");
  const lines = [
    `${theme.muted("Source:")} ${source}`,
    `${theme.muted("Entries:")} ${payload.entries}`,
  ];
  if (payload.feed) {
    lines.push(
      `${theme.muted("Feed:")} ${terminalText`${payload.feed.id}`} ${theme.muted(terminalText`sequence ${payload.feed.sequence}`)}`,
    );
  }
  if (payload.metadata?.url) {
    lines.push(`${theme.muted("URL:")} ${terminalText`${payload.metadata.url}`}`);
  }
  if (options.includeChecksum && payload.metadata?.checksum) {
    lines.push(`${theme.muted("SHA-256:")} ${terminalText`${payload.metadata.checksum}`}`);
  }
  if (payload.snapshot?.savedAt) {
    lines.push(`${theme.muted("Snapshot:")} ${terminalText`${payload.snapshot.savedAt}`}`);
  }
  if (payload.trust) {
    lines.push(`${theme.muted("Trust:")} ${formatMarketplaceFeedTrust(payload.trust)}`);
  }
  if (payload.error) {
    lines.push(`${theme.muted("Fallback reason:")} ${terminalText`${payload.error}`}`);
  }
  return lines;
}

export async function runPluginMarketplaceEntriesCommand(
  opts: PluginMarketplaceEntriesOptions,
): Promise<void> {
  if (!opts.offline) {
    return await runWithLocalPluginState("marketplace entries", () =>
      runPluginMarketplaceEntriesLocal(opts),
    );
  }
  return await runPluginMarketplaceEntriesLocal(opts);
}

async function runPluginMarketplaceEntriesLocal(
  opts: PluginMarketplaceEntriesOptions,
): Promise<void> {
  const catalog = await import("../plugins/official-external-plugin-catalog.js");
  const cfg = await captureRuntimeConfigAsyncReader()();
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
  return await runWithLocalPluginState("marketplace refresh", async () => {
    const { loadConfiguredHostedOfficialExternalPluginCatalogEntries } =
      await import("../plugins/official-external-plugin-catalog.js");
    const cfg = await captureRuntimeConfigAsyncReader()();
    let expectedSha256 = opts.expectedSha256?.trim() || undefined;
    if (expectedSha256) {
      const hash = /^(?:sha256:)?([0-9a-f]{64})$/iu.exec(expectedSha256)?.[1];
      expectedSha256 = hash ? `sha256:${hash.toLowerCase()}` : expectedSha256;
    }
    const result = await loadConfiguredHostedOfficialExternalPluginCatalogEntries({
      ...(opts.feedProfile ? { feedProfile: opts.feedProfile } : {}),
      ...(opts.feedUrl ? { feedUrl: opts.feedUrl } : {}),
      ...(expectedSha256 ? { expectedSha256 } : {}),
      requireSnapshotWrite: true,
    });
    const { clearManagedPluginCatalogCache } = await import("../plugins/management-catalog.js");
    clearManagedPluginCatalogCache();
    let runtimeNotice: string | undefined;
    if (result.source !== "bundled-fallback") {
      runtimeNotice = "Marketplace catalog saved for the next Gateway start.";
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
      if (runtimeNotice) {
        defaultRuntime.error(runtimeNotice);
      }
    } else {
      const lines = formatMarketplaceFeedLines(payload, { includeChecksum: true });
      if (runtimeNotice) {
        lines.push("", runtimeNotice);
      }
      defaultRuntime.log(lines.join("\n"));
    }
    if (failedPinnedRefresh) {
      defaultRuntime.error(
        terminalText`Pinned marketplace feed refresh did not accept a fresh hosted payload (source: ${payload.source}).`,
      );
    }
    if (failedPinnedRefresh) {
      return defaultRuntime.exit(1);
    }
  });
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
