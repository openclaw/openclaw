import { loadConfig } from "../config/config.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { listVideoGenerationProviders } from "../video-generation/provider-registry.js";

export type VideoListOpts = {
  json?: boolean;
};

type ProviderSummary = {
  id: string;
  label?: string;
  defaultModel?: string;
  models: string[];
  configured: boolean;
  capabilities: {
    audio: boolean;
    aspectRatio: boolean;
    resolution: boolean;
    maxDurationSeconds?: number;
    maxInputImages?: number;
    maxInputVideos?: number;
  };
};

function buildProviderSummaries(cfg: ReturnType<typeof loadConfig>): ProviderSummary[] {
  const providers = listVideoGenerationProviders(cfg);
  return providers
    .map((p) => ({
      id: p.id,
      label: p.label,
      defaultModel: p.defaultModel,
      models: p.models ?? [],
      configured: typeof p.isConfigured === "function" ? p.isConfigured({ cfg }) : false,
      capabilities: {
        audio: p.capabilities.supportsAudio ?? false,
        aspectRatio: p.capabilities.supportsAspectRatio ?? false,
        resolution: p.capabilities.supportsResolution ?? false,
        maxDurationSeconds: p.capabilities.maxDurationSeconds,
        maxInputImages: p.capabilities.maxInputImages,
        maxInputVideos: p.capabilities.maxInputVideos,
      },
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

function formatTable(summaries: ProviderSummary[]): string {
  if (summaries.length === 0) {
    return "No video generation providers available.\nInstall and configure a provider plugin to get started.";
  }

  const header = ["Provider", "Default Model", "Models", "Configured", "Audio", "Max Duration"];
  const rows = summaries.map((s) => [
    s.id,
    s.defaultModel ?? "-",
    String(s.models.length),
    s.configured ? "yes" : "no",
    s.capabilities.audio ? "yes" : "no",
    s.capabilities.maxDurationSeconds ? `${s.capabilities.maxDurationSeconds}s` : "-",
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));

  const pad = (val: string, width: number) => val.padEnd(width);
  const headerLine = header.map((h, i) => pad(h, widths[i])).join("  ");
  const separator = widths.map((w) => "─".repeat(w)).join("  ");
  const body = rows.map((row) => row.map((cell, i) => pad(cell, widths[i])).join("  ")).join("\n");

  return `${headerLine}\n${separator}\n${body}`;
}

export async function videoListCommand(
  opts: VideoListOpts,
  runtime: OutputRuntimeEnv,
): Promise<void> {
  const cfg = loadConfig();
  const summaries = buildProviderSummaries(cfg);

  if (opts.json) {
    runtime.writeJson(summaries);
    return;
  }

  runtime.log(formatTable(summaries));
}
