import fs from "node:fs";
import JSON5 from "json5";
import { readConfigIncludeFileWithGuards, resolveConfigIncludes } from "../config/includes.js";
import { coerceConfig } from "../config/io.read-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function readUpgradeConfig(configPath: string): {
  config: OpenClawConfig;
  files: Map<string, { raw: string; canonicalPath: string }>;
} {
  const files = new Map<string, { raw: string; canonicalPath: string }>();
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    files.set(configPath, { raw, canonicalPath: fs.realpathSync(configPath) });
    // Doctor owns validation and migration; retain its authored inputs, not a flattened config.
    const config = coerceConfig(
      resolveConfigIncludes(JSON5.parse(raw), configPath, {
        readFile: (file) => fs.readFileSync(file, "utf8"),
        readFileWithGuards: (params) => {
          let canonicalPath = params.resolvedPath;
          const included = readConfigIncludeFileWithGuards({
            ...params,
            onResolvedPath: (resolved) => {
              canonicalPath = resolved;
            },
          });
          files.set(params.resolvedPath, { raw: included, canonicalPath });
          return included;
        },
        parseJson: (text) => JSON5.parse(text),
      }),
    );
    return { config, files };
  } catch {
    return { config: {}, files };
  }
}
