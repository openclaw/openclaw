import { z } from "zod";
import { LoggingLevelSchema } from "./zod-schema.root-support.js";

// OpenTelemetry instrument names start with an ASCII letter and allow only these characters.
// The 128-character prefix cap leaves ample room within the dependency's 255-character name cap.
const MetricNamePrefixSchema = z
  .string()
  .max(128)
  .regex(/^(?:[A-Za-z][A-Za-z0-9_./-]*)?$/);

export const DiagnosticsConfigSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    /** Optional ad-hoc diagnostics flags (e.g. "telegram.http"). */
    flags: z.array(z.string()).optional(),
    otel: z
      .strictObject({
        enabled: z.boolean().optional(),
        endpoint: z.string().optional(),
        tracesEndpoint: z.string().optional(),
        metricsEndpoint: z.string().optional(),
        logsEndpoint: z.string().optional(),
        protocol: z.literal("http/protobuf").optional(),
        headers: z.record(z.string(), z.string()).optional(),
        serviceName: z.string().optional(),
        /** Replacement prefix for OpenClaw-owned metric names. Empty removes the prefix; defaults to "openclaw.". */
        metricNamePrefix: MetricNamePrefixSchema.optional(),
        traces: z.boolean().optional(),
        metrics: z.boolean().optional(),
        logs: z.boolean().optional(),
        /** Log export sink: OTLP by default, stdout JSONL, or both. */
        logsExporter: z
          .union([z.literal("otlp"), z.literal("stdout"), z.literal("both")])
          .optional(),
        /** Trace sample rate (0.0 - 1.0). */
        sampleRate: z.number().min(0).max(1).optional(),
        /** Metric export interval (ms). */
        flushIntervalMs: z.number().int().nonnegative().optional(),
        /** Opt in to raw non-system message/tool content in OTEL span attributes. */
        captureContent: z.boolean().optional(),
      })
      .optional(),
    cacheTrace: z
      .strictObject({
        /** Write prompt-cache trace artifacts for debugging deterministic cache input. */
        enabled: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();

export const LoggingConfigSchema = z
  .strictObject({
    level: LoggingLevelSchema.optional(),
    file: z.string().optional(),
    /** Maximum size of a single log file in bytes before rotation. Default: 100 MB. */
    maxFileBytes: z.number().int().positive().optional(),
    consoleLevel: LoggingLevelSchema.optional(),
    consoleStyle: z.union([z.literal("pretty"), z.literal("json")]).optional(),
    /** Redact sensitive tokens in log sinks and persisted transcript text. Default: "tools". Safety-boundary UI/tool/diagnostic payloads may still redact when this is "off". */
    /** Regex patterns used to redact sensitive tokens from logs and transcripts. */
    redactPatterns: z.array(z.string()).optional(),
    /** Metadata-only agent activity audit ledger settings. */
    audit: z
      .strictObject({
        /**
         * Record metadata-only run, tool, and enabled message lifecycle events into
         * the shared state database. Content is never stored. Default: true. This is
         * startup-scoped; disabling stops new event inserts after restart while retained
         * records stay readable until they expire.
         */
        enabled: z.boolean().optional(),
        /**
         * Retain bounded execution-identity attribution for exact-run inspection.
         * Default: false. Requires the audit ledger and takes effect after Gateway restart.
         */
        executionIdentity: z.boolean().optional(),
        /**
         * Record content-free message lifecycle metadata. `direct` records only
         * known direct conversations; `all` also records group, channel, and
         * unknown conversation kinds. Default: `off`.
         */
        messages: z.union([z.literal("off"), z.literal("direct"), z.literal("all")]).optional(),
      })
      .optional(),
  })
  .optional();
