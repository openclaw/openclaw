/**
 * Config presets for quick configuration profiles.
 * Each preset applies a set of config values optimized for specific use cases.
 */

export type ConfigPreset = {
  id: string;
  name: string;
  description: string;
  emoji: string;
  /** Partial config object to merge into the current config */
  values: Record<string, unknown>;
};

export const CONFIG_PRESETS: ConfigPreset[] = [
  {
    id: "fast-chat",
    name: "Fast Chat",
    emoji: "\u26a1",
    description: "Optimized for quick, responsive conversations with minimal latency.",
    values: {
      agents: {
        defaults: {
          thinkingDefault: "minimal",
          verboseDefault: "off",
          timeoutSeconds: 60,
          blockStreamingDefault: "on",
          typingMode: "instant",
        },
      },
    },
  },
  {
    id: "coding-agent",
    name: "Coding Agent",
    emoji: "\ud83d\udcbb",
    description: "Enhanced reasoning and tools for software development tasks.",
    values: {
      agents: {
        defaults: {
          thinkingDefault: "high",
          verboseDefault: "on",
          elevatedDefault: "on",
          timeoutSeconds: 300,
          contextTokens: 180000,
        },
      },
      tools: {
        bash: { enabled: true },
        edit: { enabled: true },
        read: { enabled: true },
        write: { enabled: true },
        glob: { enabled: true },
        grep: { enabled: true },
      },
    },
  },
  {
    id: "voice-assistant",
    name: "Voice Assistant",
    emoji: "\ud83c\udf99\ufe0f",
    description: "Optimized for voice input and natural conversation flow.",
    values: {
      agents: {
        defaults: {
          thinkingDefault: "low",
          verboseDefault: "off",
          blockStreamingDefault: "on",
          blockStreamingBreak: "text_end",
          typingMode: "never",
          humanDelay: {
            enabled: true,
            minMs: 500,
            maxMs: 1500,
          },
        },
      },
      audio: {
        transcription: {
          enabled: true,
          provider: "whisper",
        },
      },
    },
  },
  {
    id: "privacy-first",
    name: "Privacy First",
    emoji: "\ud83d\udd12",
    description: "Maximum privacy with minimal data retention and logging.",
    values: {
      logging: {
        level: "error",
        redactSensitive: "tools",
      },
      diagnostics: {
        enabled: false,
        otel: {
          enabled: false,
        },
        cacheTrace: {
          enabled: false,
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            enabled: false,
          },
        },
      },
    },
  },
];

/**
 * Deep merge two objects, with source values overwriting target values.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = result[key];
    if (
      sourceValue !== null &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>,
      );
    } else {
      result[key] = sourceValue;
    }
  }
  return result;
}

/**
 * Apply a preset to a config object, merging the preset values.
 */
export function applyPreset(
  config: Record<string, unknown>,
  presetId: string,
): Record<string, unknown> {
  const preset = CONFIG_PRESETS.find((p) => p.id === presetId);
  if (!preset) return config;
  return deepMerge(config, preset.values);
}

/**
 * Get a preset by ID.
 */
export function getPreset(presetId: string): ConfigPreset | undefined {
  return CONFIG_PRESETS.find((p) => p.id === presetId);
}
