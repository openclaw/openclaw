import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { collectConfiguredRuntimePluginIds } from "../commands/doctor/shared/configured-runtime-plugin-owners.js";
import { captureRuntimeConfigAsyncReader, readConfigFileSnapshot } from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { resolvePluginInstallSources } from "../plugins/install-channel-specs.js";
import { resolveConfiguredRuntimePluginInstallCandidate } from "../plugins/official-runtime-plugins.js";
import { displayPath, shortenHomeInString, shortenHomePath } from "../utils.js";
import type { PluginDoctorOptions } from "./plugins-cli.js";

function isConfigSelectedShadowDiagnostic(entry: { level?: string; message?: string }): boolean {
  return (
    (entry.level === "info" || entry.level === "warn") &&
    typeof entry.message === "string" &&
    entry.message.includes("duplicate plugin id resolved by explicit config-selected plugin")
  );
}

export async function collectPluginsDoctorReport(
  opts: PluginDoctorOptions = {},
): Promise<{ output: string; exitCode: number }> {
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
  const cfg = await captureRuntimeConfigAsyncReader()();
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
      ]);
      const enabledPluginIds = new Set(
        report.plugins
          .filter((plugin) => plugin.enabled && plugin.status !== "disabled")
          .map((plugin) => plugin.id),
      );
      for (const warning of collectConfiguredRuntimePluginIds(sourceCfg, {
        includeImplicitRuntimePreferences: false,
      }).flatMap((pluginId) => {
        const candidate = resolveConfiguredRuntimePluginInstallCandidate(pluginId);
        if (!candidate || enabledPluginIds.has(pluginId)) {
          return [];
        }
        const disabledPluginRecord = report.plugins.find((plugin) => plugin.id === pluginId);
        const policy = sourceCfg.plugins;
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
        const installSource = resolvePluginInstallSources(candidate)[0];
        const installSpec = installSource?.spec ?? candidate.pluginId;
        const installTarget = installSource?.source === "npm" ? `npm:${installSpec}` : installSpec;
        return [
          `${prefix}, but no enabled "${pluginId}" plugin was found. Run "openclaw doctor --fix" to install ${installSpec}, or install it manually with "openclaw plugins install ${installTarget}".`,
        ];
      })) {
        pluginConfigWarnings.add(warning);
      }
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
          return terminalText`- ${entry.id}${phase}: ${entry.error ?? "failed to load"} (${entry.source})`;
        }),
      );
      appendSection(
        theme.warn("Diagnostics:"),
        diags.map((diag) => {
          const target = diag.pluginId ? `${diag.pluginId}: ` : "";
          return terminalText`- ${target}${diag.message}`;
        }),
      );
      appendSection(
        theme.warn("Plugin source shadowing:"),
        shadowed.flatMap((diag) => {
          const active = report.plugins.find((plugin) => plugin.id === diag.pluginId);
          const target = diag.pluginId ? `${diag.pluginId}: ` : "";
          const details = [terminalText`- ${target}${diag.message}`];
          if (active) {
            details.push(terminalText`  active: ${displayPath(active.source)} (${active.origin})`);
            if (active.status === "error") {
              details.push(
                terminalText`  active status: error${active.error ? `: ${active.error}` : ""}`,
              );
            }
          }
          if (diag.source) {
            details.push(`  shadowed: ${displayPath(diag.source)}`);
          }
          details.push(
            "  repair:",
            terminalText`    openclaw plugins inspect ${diag.pluginId ?? "<plugin-id>"}`,
            "    edit or remove the config-selected plugin source",
            "    openclaw plugins registry --refresh",
            terminalText`    openclaw plugins reload ${diag.pluginId ?? "<plugin-id>"}`,
          );
          return details;
        }),
      );
      appendSection(
        theme.warn("Compatibility:"),
        compatibility.map((notice) => {
          const marker = notice.severity === "warn" ? theme.warn("warn") : theme.muted("info");
          return `- ${terminalText`${formatPluginCompatibilityNotice(notice)}`} [${marker}]`;
        }),
      );
      appendSection(
        theme.warn("Plugin configuration:"),
        [...pluginConfigWarnings].map((warning) => terminalText`${warning}`),
      );
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
  return { output, exitCode };
}
