export const MEMORY_CORE_CONFIG_SCHEMA = {
  $id: "https://openclaw.dev/schemas/plugins/memory-core/config.json",
  title: "Memory Core Plugin Config",
  description: "Configuration for the memory-core plugin, including dreaming settings.",
  type: "object",
  properties: {
    dreaming: {
      type: "object",
      description: "Dreaming configuration for memory consolidation and processing.",
      properties: {
        enabled: {
          type: "boolean",
          description: "Whether dreaming is enabled.",
        },
        timezone: {
          type: "string",
          description: "Timezone for scheduling dreaming tasks.",
        },
        verboseLogging: {
          type: "boolean",
          description: "Enable verbose logging for dreaming operations.",
        },
        storage: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["inline", "separate", "both"],
            },
            separateReports: {
              type: "boolean",
            },
          },
          additionalProperties: false,
        },
        frequency: {
          type: "string",
          description: "Cron expression for general dreaming frequency.",
        },
        execution: {
          type: "object",
          properties: {
            speed: {
              type: "string",
              enum: ["fast", "balanced", "slow"],
            },
            thinking: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
            budget: {
              type: "string",
              enum: ["cheap", "medium", "expensive"],
            },
            model: {
              type: "string",
            },
            maxOutputTokens: {
              type: "number",
            },
            temperature: {
              type: "number",
            },
            timeoutMs: {
              type: "number",
            },
          },
          additionalProperties: false,
        },
        light: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            cron: { type: "string" },
            lookbackDays: { type: "number" },
            limit: { type: "number" },
            dedupeSimilarity: { type: "number" },
            sources: {
              type: "array",
              items: {
                type: "string",
                enum: ["daily", "sessions", "recall"],
              },
            },
            execution: {
              type: "object",
              properties: {
                speed: { type: "string", enum: ["fast", "balanced", "slow"] },
                thinking: { type: "string", enum: ["low", "medium", "high"] },
                budget: { type: "string", enum: ["cheap", "medium", "expensive"] },
                model: { type: "string" },
                maxOutputTokens: { type: "number" },
                temperature: { type: "number" },
                timeoutMs: { type: "number" },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        deep: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            cron: { type: "string" },
            limit: { type: "number" },
            minScore: { type: "number" },
            minRecallCount: { type: "number" },
            minUniqueQueries: { type: "number" },
            recencyHalfLifeDays: { type: "number" },
            maxAgeDays: { type: "number" },
            sources: {
              type: "array",
              items: {
                type: "string",
                enum: ["daily", "memory", "sessions", "logs", "recall"],
              },
            },
            recovery: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                triggerBelowHealth: { type: "number" },
                lookbackDays: { type: "number" },
                maxRecoveredCandidates: { type: "number" },
                minRecoveryConfidence: { type: "number" },
                autoWriteMinConfidence: { type: "number" },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        rem: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            cron: { type: "string" },
            lookbackDays: { type: "number" },
            limit: { type: "number" },
            minPatternStrength: { type: "number" },
            sources: {
              type: "array",
              items: {
                type: "string",
                enum: ["memory", "daily", "deep"],
              },
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;
