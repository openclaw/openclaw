import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelResolveKind, ChannelResolveResult } from "../../channels/plugins/types.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getChannelsCommandSecretTargetIds } from "../../cli/command-secret-targets.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { danger } from "../../globals.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { resolveInstallableChannelPlugin } from "../channel-setup/channel-plugin-resolution.js";

export type ChannelsResolveOptions = {
  channel?: string;
  account?: string;
  kind?: "auto" | "user" | "group" | "channel";
  json?: boolean;
  entries?: string[];
};

type ResolveResult = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  error?: string;
  note?: string;
};

function resolvePreferredKind(
  kind?: ChannelsResolveOptions["kind"],
): ChannelResolveKind | undefined {
  if (!kind || kind === "auto") {
    return undefined;
  }
  if (kind === "user") {
    return "user";
  }
  return "group";
}

function detectAutoKind(input: string): ChannelResolveKind {
  const trimmed = input.trim();
  if (!trimmed) {
    return "group";
  }
  if (trimmed.startsWith("@")) {
    return "user";
  }
  if (/^<@!?/.test(trimmed)) {
    return "user";
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return "user";
  }
  if (
    /^(user|discord|slack|matrix|msteams|teams|zalo|zalouser|googlechat|google-chat|gchat):/i.test(
      trimmed,
    )
  ) {
    return "user";
  }
  return "group";
}

function formatResolveResult(result: ResolveResult): string {
  if (!result.resolved || !result.id) {
    return `${result.input} -> unresolved`;
  }
  const name = result.name ? ` (${result.name})` : "";
  const note = result.note ? ` [${result.note}]` : "";
  return `${result.input} -> ${result.id}${name}${note}`;
}

export async function channelsResolveCommand(opts: ChannelsResolveOptions, runtime: RuntimeEnv) {
  const loadedRaw = loadConfig();
  const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config: loadedRaw,
    commandName: "channels resolve",
    targetIds: getChannelsCommandSecretTargetIds(),
    mode: "read_only_operational",
  });
  let cfg = resolvedConfig;
  for (const entry of diagnostics) {
    runtime.log(`[secrets] ${entry}`);
  }
  const entries = (opts.entries ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error("At least one entry is required.");
  }

  const explicitChannel = opts.channel?.trim();
  const resolvedExplicit = explicitChannel
    ? await resolveInstallableChannelPlugin({
        cfg,
        runtime,
        rawChannel: explicitChannel,
        allowInstall: true,
        supports: (plugin) => Boolean(plugin.resolver?.resolveTargets),
      })
    : null;
  if (resolvedExplicit?.configChanged) {
    cfg = resolvedExplicit.cfg;
    await writeConfigFile(cfg);
  }

  const selection = explicitChannel
    ? {
        channel: resolvedExplicit?.channelId,
      }
    : await resolveMessageChannelSelection({
        cfg,
        channel: opts.channel ?? null,
      });
  const plugin =
    (explicitChannel ? resolvedExplicit?.plugin : undefined) ??
    (selection.channel ? getChannelPlugin(selection.channel) : undefined);
  if (!plugin?.resolver?.resolveTargets) {
    const channelText = selection.channel ?? explicitChannel ?? "";
    throw new Error(`Channel ${channelText} does not support resolve.`);
  }
  const preferredKind = resolvePreferredKind(opts.kind);

  let results: ResolveResult[] = [];
  if (preferredKind) {
    const resolved = await plugin.resolver.resolveTargets({
      cfg,
      accountId: opts.account ?? null,
      inputs: entries,
      kind: preferredKind,
      runtime,
    });
    results = resolved.map((entry) => ({
      input: entry.input,
      resolved: entry.resolved,
      id: entry.id,
      name: entry.name,
      note: entry.note,
    }));
  } else {
    const byKind = new Map<ChannelResolveKind, string[]>();
    for (const entry of entries) {
      const kind = detectAutoKind(entry);
      byKind.set(kind, [...(byKind.get(kind) ?? []), entry]);
    }
    const resolved: ChannelResolveResult[] = [];
    for (const [kind, inputs] of byKind.entries()) {
      const batch = await plugin.resolver.resolveTargets({
        cfg,
        accountId: opts.account ?? null,
        inputs,
        kind,
        runtime,
      });
      resolved.push(...batch);
    }
    const byInput = new Map(resolved.map((entry) => [entry.input, entry]));
    results = entries.map((input) => {
      const entry = byInput.get(input);
      return {
        input,
        resolved: entry?.resolved ?? false,
        id: entry?.id,
        name: entry?.name,
        note: entry?.note,
      };
    });
  }

  if (opts.json) {
    writeRuntimeJson(runtime, results);
    return;
  }

  for (const result of results) {
    if (result.resolved && result.id) {
      runtime.log(formatResolveResult(result));
    } else {
      runtime.error(
        danger(
          `${result.input} -> unresolved${result.error ? ` (${result.error})` : result.note ? ` (${result.note})` : ""}`,
        ),
      );
    }
  }
}
