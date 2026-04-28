import type { HardwareInfo } from "./hardware.js";

// ---------------------------------------------------------------------------
// Model catalog: edit this structure to update model recommendations.
// Each model entry maps to an Ollama tag. Hardware tiers map RAM ranges
// to the best model for that class of device.
//
// knownIssues: document failures, regressions, and platform-specific bugs
// discovered during testing. Each issue has a status ("open" or "resolved"),
// affected hardware/quant scope, date discovered, and a citation URL.
// The selector skips models with open blockers matching the current hardware.
// ---------------------------------------------------------------------------

export type KnownIssue = {
  id: string;
  status: "open" | "resolved";
  severity: "blocker" | "degraded" | "cosmetic";
  summary: string;
  affectedPlatforms?: readonly string[];
  affectedQuants?: readonly string[];
  discoveredDate: string;
  resolvedDate?: string;
  resolvedInVersion?: string;
  citations: readonly string[];
  workaround?: string;
  testedBy?: string;
};

export type CatalogModel = {
  id: string;
  family: string;
  displayName: string;
  ollamaTag: string;
  parameterCount: string;
  contextLength: number;
  modalities: readonly string[];
  downloadSizeBytes: number;
  runtimeMemoryBytes: number;
  architecture?: string;
  quant?: string;
  tier: string;
  knownIssues?: readonly KnownIssue[];
};

export type HardwareTier = {
  tier: string;
  description: string;
  minRamBytes: number;
  maxRamBytes: number | null;
  modelId: string;
  fallbackModelId?: string;
};

export type ModelCatalog = {
  models: readonly CatalogModel[];
  hardwareTiers: readonly HardwareTier[];
};

export type ModelRecommendation = {
  model: CatalogModel;
  tier: HardwareTier;
  reason: string;
  skippedIssues?: readonly KnownIssue[];
};

export const MODEL_CATALOG: ModelCatalog = {
  models: [
    {
      id: "gemma4:e2b",
      family: "gemma4",
      displayName: "Gemma 4 E2B",
      ollamaTag: "gemma4:e2b",
      parameterCount: "2.3B effective (5.1B total)",
      contextLength: 131_072,
      modalities: ["text", "image", "audio"],
      downloadSizeBytes: 7_200_000_000,
      runtimeMemoryBytes: 8_500_000_000,
      tier: "edge",
    },
    {
      id: "gemma4:e4b",
      family: "gemma4",
      displayName: "Gemma 4 E4B",
      ollamaTag: "gemma4:e4b",
      parameterCount: "4.5B effective (8B total)",
      contextLength: 131_072,
      modalities: ["text", "image", "audio"],
      downloadSizeBytes: 9_600_000_000,
      runtimeMemoryBytes: 12_000_000_000,
      tier: "default",
    },
    {
      id: "gemma4:26b",
      family: "gemma4",
      displayName: "Gemma 4 26B MoE (4B active)",
      ollamaTag: "gemma4:26b",
      parameterCount: "25.2B total (3.8B active)",
      contextLength: 262_144,
      modalities: ["text", "image"],
      downloadSizeBytes: 18_000_000_000,
      runtimeMemoryBytes: 22_000_000_000,
      architecture: "moe",
      quant: "q4_K_M",
      tier: "workstation",
      knownIssues: [
        {
          id: "gemma4-26b-moe-cold-load-reset",
          status: "open",
          severity: "cosmetic",
          summary: "One-time monitor reset during cold model load on Apple Silicon, then stable.",
          affectedPlatforms: ["darwin-arm64"],
          discoveredDate: "2026-04-06",
          citations: ["https://github.com/ollama/ollama/issues/15368"],
          testedBy: "gemmaclaw-setup",
        },
      ],
    },
    {
      id: "gemma4:31b",
      family: "gemma4",
      displayName: "Gemma 4 31B Dense",
      ollamaTag: "gemma4:31b",
      parameterCount: "30.7B",
      contextLength: 262_144,
      modalities: ["text", "image"],
      downloadSizeBytes: 20_000_000_000,
      runtimeMemoryBytes: 24_000_000_000,
      quant: "q4_K_M",
      tier: "high-memory",
      knownIssues: [
        {
          id: "gemma4-31b-fa-hang",
          status: "open",
          severity: "blocker",
          summary:
            "Flash Attention hangs indefinitely on prompts >500 tokens. " +
            "Gemma 4 hybrid attention (50 sliding-window + 10 global layers with different head dims 256/512) " +
            "breaks the FA implementation. GPU drops to 0%, complete stall.",
          affectedPlatforms: ["darwin-arm64", "linux-nvidia"],
          discoveredDate: "2026-04-04",
          citations: [
            "https://github.com/ollama/ollama/issues/15368",
            "https://github.com/ollama/ollama/issues/15350",
            "https://github.com/ollama/ollama/issues/15286",
          ],
          workaround: "Set OLLAMA_FLASH_ATTENTION=0 (slow: ~15 tok/s gen on M4 Max).",
          testedBy: "gemmaclaw-setup",
        },
        {
          id: "gemma4-31b-monitor-reset",
          status: "open",
          severity: "blocker",
          summary:
            "Monitor/display reset (screen flickering) on Apple Silicon when processing prompts >1000 tokens. " +
            "The dense model reads 16.5 GiB weights per step, saturating memory bandwidth.",
          affectedPlatforms: ["darwin-arm64"],
          discoveredDate: "2026-04-06",
          citations: ["https://github.com/ollama/ollama/issues/15368"],
          testedBy: "gemmaclaw-setup frank M4 Max 48GB 2026-04-27",
        },
        {
          id: "gemma4-31b-memory-leak",
          status: "open",
          severity: "blocker",
          summary:
            "Memory usage grows unboundedly during prompt preprocessing on macOS. " +
            "LM Studio reported 221 GB usage on 64 GB M4 Max. Ollama shows similar growth. " +
            "Can cause full system crash if unattended.",
          affectedPlatforms: ["darwin-arm64"],
          discoveredDate: "2026-04-04",
          citations: ["https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1750"],
          testedBy: "gemmaclaw-setup",
        },
      ],
    },
    {
      id: "gemma4:31b-it-q8_0",
      family: "gemma4",
      displayName: "Gemma 4 31B Dense (Q8)",
      ollamaTag: "gemma4:31b-it-q8_0",
      parameterCount: "30.7B",
      contextLength: 262_144,
      modalities: ["text", "image"],
      downloadSizeBytes: 34_000_000_000,
      runtimeMemoryBytes: 38_000_000_000,
      quant: "q8_0",
      tier: "high-memory-q8",
      knownIssues: [
        {
          id: "gemma4-31b-q8-smoke-fail-48gb",
          status: "open",
          severity: "blocker",
          summary:
            "Smoke test returns empty response on M4 Max 48GB. Model loads but fails to generate. " +
            "Likely OOM during inference with 38 GB model + KV cache exceeding 48 GB unified memory.",
          affectedPlatforms: ["darwin-arm64"],
          discoveredDate: "2026-04-27",
          citations: [],
          testedBy: "gemmaclaw-setup frank M4 Max 48GB 2026-04-27",
        },
        {
          id: "gemma4-31b-q8-fa-hang",
          status: "open",
          severity: "blocker",
          summary:
            "Inherits the same Flash Attention hang as gemma4:31b Q4 on prompts >500 tokens.",
          affectedPlatforms: ["darwin-arm64", "linux-nvidia"],
          discoveredDate: "2026-04-06",
          citations: ["https://github.com/ollama/ollama/issues/15368"],
          testedBy: "gemmaclaw-setup",
        },
      ],
    },
  ],

  hardwareTiers: [
    {
      tier: "minimal",
      description: "Very limited RAM, phones, low-end SBCs",
      minRamBytes: 0,
      maxRamBytes: 8_000_000_000,
      modelId: "gemma4:e2b",
    },
    {
      tier: "edge",
      description: "8-12 GB RAM laptops, tablets, entry Macs",
      minRamBytes: 8_000_000_000,
      maxRamBytes: 12_000_000_000,
      modelId: "gemma4:e2b",
    },
    {
      tier: "default",
      description: "12-20 GB RAM, most consumer laptops and desktops",
      minRamBytes: 12_000_000_000,
      maxRamBytes: 20_000_000_000,
      modelId: "gemma4:e4b",
    },
    {
      tier: "workstation",
      description: "20-36 GB RAM, pro laptops, workstations, Apple Silicon 24GB+",
      minRamBytes: 20_000_000_000,
      maxRamBytes: 36_000_000_000,
      modelId: "gemma4:26b",
    },
    {
      tier: "high-memory",
      description: "36+ GB RAM, M-series Max/Ultra, NVIDIA workstations, servers",
      minRamBytes: 36_000_000_000,
      maxRamBytes: null,
      modelId: "gemma4:31b",
      fallbackModelId: "gemma4:26b",
    },
  ],
};

function resolvePlatformKey(hw: HardwareInfo): string {
  if (hw.gpu.apple) {
    return "darwin-arm64";
  }
  if (hw.gpu.nvidia) {
    return "linux-nvidia";
  }
  if (process.platform === "darwin") {
    return `darwin-${process.arch}`;
  }
  return `${process.platform}-${process.arch}`;
}

function hasOpenBlocker(model: CatalogModel, platformKey: string): KnownIssue | undefined {
  if (!model.knownIssues) {
    return undefined;
  }
  return model.knownIssues.find(
    (issue) =>
      issue.status === "open" &&
      issue.severity === "blocker" &&
      (!issue.affectedPlatforms || issue.affectedPlatforms.includes(platformKey)),
  );
}

function getOpenIssues(model: CatalogModel, platformKey: string): readonly KnownIssue[] {
  if (!model.knownIssues) {
    return [];
  }
  return model.knownIssues.filter(
    (issue) =>
      issue.status === "open" &&
      (!issue.affectedPlatforms || issue.affectedPlatforms.includes(platformKey)),
  );
}

/**
 * Pick the best model for the detected hardware.
 *
 * Uses total system RAM (unified memory on Apple Silicon) to find the highest
 * tier the system qualifies for. GPU-accelerated systems use full RAM.
 * CPU-only systems apply a 75% headroom factor so the OS stays responsive.
 *
 * If the preferred model has open blocker-severity issues for the current
 * platform, the selector falls back to the tier's fallbackModelId.
 */
export function selectBestModel(hw: HardwareInfo): ModelRecommendation {
  const catalog = MODEL_CATALOG;
  const platformKey = resolvePlatformKey(hw);

  const hasGpuAccel = hw.gpu.detected && (hw.gpu.apple || hw.gpu.nvidia);
  const effectiveRam = hasGpuAccel ? hw.ram.totalBytes : Math.floor(hw.ram.totalBytes * 0.75);

  let matchedTier: HardwareTier | undefined;
  for (const tier of catalog.hardwareTiers) {
    const max = tier.maxRamBytes ?? Number.MAX_SAFE_INTEGER;
    if (effectiveRam >= tier.minRamBytes && effectiveRam < max) {
      matchedTier = tier;
      break;
    }
  }

  if (!matchedTier) {
    const sorted = [...catalog.hardwareTiers].toSorted((a, b) => b.minRamBytes - a.minRamBytes);
    matchedTier = sorted.find((t) => effectiveRam >= t.minRamBytes) ?? catalog.hardwareTiers[0];
  }

  const tier = matchedTier;
  const primaryModel = catalog.models.find((m) => m.id === tier.modelId);
  const fallbackModel = tier.fallbackModelId
    ? catalog.models.find((m) => m.id === tier.fallbackModelId)
    : undefined;

  let model = primaryModel;
  let skippedIssues: KnownIssue[] = [];

  if (model) {
    const blocker = hasOpenBlocker(model, platformKey);
    if (blocker && fallbackModel) {
      skippedIssues = [...getOpenIssues(model, platformKey)];
      model = fallbackModel;
    }
  }

  if (!model) {
    const fallback = catalog.models[0];
    return {
      model: fallback,
      tier,
      reason: `Fallback to ${fallback.displayName} (catalog model ${tier.modelId} not found).`,
    };
  }

  const ramGb = Math.round(hw.ram.totalBytes / 1024 ** 3);
  const parts: string[] = [];

  if (hw.gpu.apple) {
    parts.push(`Apple Silicon with ${ramGb} GB unified memory`);
  } else if (hw.gpu.nvidia && hw.gpu.vramBytes) {
    const vramGb = Math.round(hw.gpu.vramBytes / 1024 ** 3);
    parts.push(`NVIDIA GPU with ${vramGb} GB VRAM, ${ramGb} GB system RAM`);
  } else {
    parts.push(`${ramGb} GB RAM (CPU inference)`);
  }

  if (skippedIssues.length > 0 && primaryModel) {
    parts.push(
      `${primaryModel.displayName} skipped due to ${skippedIssues.length} open issue(s) on ${platformKey}`,
    );
  }

  parts.push(tier.description);

  return {
    model,
    tier,
    reason: `${parts.join(". ")}.`,
    skippedIssues: skippedIssues.length > 0 ? skippedIssues : undefined,
  };
}
