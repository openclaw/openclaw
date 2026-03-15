import fs from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import {
  OUTPUT_MODES,
  RADAR_TOOL_NAMES,
  REVIEW_ANALYZERS,
  REVIEW_SEVERITIES,
  type RadarDefenderConfig,
} from "../core/types.js";
import { DEFAULT_RADAR_DEFENDER_CONFIG } from "./radar-defaults.js";

const partialConfigSchema = z
  .object({
    server: z
      .object({
        name: z.string().min(1).optional(),
        transport: z.enum(["stdio"]).optional(),
      })
      .strict()
      .optional(),
    review: z
      .object({
        minimumSeverity: z.enum(REVIEW_SEVERITIES).optional(),
        enabledTools: z.array(z.enum(RADAR_TOOL_NAMES)).min(1).optional(),
        enabledAnalyzers: z.array(z.enum(REVIEW_ANALYZERS)).min(1).optional(),
        outputMode: z.enum(OUTPUT_MODES).optional(),
      })
      .strict()
      .optional(),
    contextOverrides: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type PartialRadarDefenderConfig = z.output<typeof partialConfigSchema>;

export type RadarDefenderCliArgs = {
  configPath?: string;
  transport?: "stdio";
};

export function parseRadarDefenderCliArgs(argv: string[]): RadarDefenderCliArgs {
  const args = argv.slice(2);
  const parsed: RadarDefenderCliArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--config") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("Missing value for --config");
      }
      parsed.configPath = next;
      index += 1;
      continue;
    }
    if (token === "--transport") {
      const next = args[index + 1];
      if (next !== "stdio") {
        throw new Error(
          `Unsupported transport: ${next ?? "<missing>"}. Only stdio is available in v1.`,
        );
      }
      parsed.transport = "stdio";
      index += 1;
      continue;
    }
  }
  return parsed;
}

function mergeConfig(
  base: RadarDefenderConfig,
  override: PartialRadarDefenderConfig | undefined,
): RadarDefenderConfig {
  return {
    server: {
      ...base.server,
      ...override?.server,
    },
    review: {
      ...base.review,
      ...override?.review,
    },
    contextOverrides: {
      ...base.contextOverrides,
      ...override?.contextOverrides,
    },
  };
}

export async function loadRadarConfig(configPath?: string): Promise<RadarDefenderConfig> {
  if (!configPath) {
    return DEFAULT_RADAR_DEFENDER_CONFIG;
  }

  const absolutePath = path.resolve(configPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const parsed = partialConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Invalid radar defender config at ${absolutePath}: ${issue?.path.join(".") || "root"} ${issue?.message || "is invalid"}`,
    );
  }

  return mergeConfig(DEFAULT_RADAR_DEFENDER_CONFIG, parsed.data);
}
