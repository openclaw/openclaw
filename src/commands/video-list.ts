import { loadConfig } from "../config/config.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
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
      configured:
        typeof p.isConfigured === "function" ? p.isConfigured({ cfg, agentDir: undefined }) : false,
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

  if (summaries.length === 0) {
    runtime.log(
      "No video generation providers available.\nInstall and configure a provider plugin to get started.",
    );
    return;
  }

  const table = renderTable({
    columns: [
      { key: "provider", header: "Provider" },
      { key: "defaultModel", header: "Default Model", flex: true },
      { key: "models", header: "Models" },
      { key: "configured", header: "Configured" },
      { key: "audio", header: "Audio" },
      { key: "maxDuration", header: "Max Duration" },
    ],
    rows: summaries.map((s) => ({
      provider: s.id,
      defaultModel: s.defaultModel ?? "-",
      models: String(s.models.length),
      configured: s.configured ? "yes" : "no",
      audio: s.capabilities.audio ? "yes" : "no",
      maxDuration: s.capabilities.maxDurationSeconds
        ? `${s.capabilities.maxDurationSeconds}s`
        : "-",
    })),
  });

  runtime.log(table);
}
