import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { readConfigIncludeFileWithGuards, resolveConfigIncludes } from "../config/includes.js";
import { coerceConfig } from "../config/io.read-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fileStamp } from "./state-upgrade-tree.js";

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

/** Stage only authored config dependencies, including inputs excluded by the state copy. */
export function copyUpgradeConfigInputs(params: {
  configPath: string;
  shadowConfig: string;
  files: ReadonlyMap<string, { raw: string; canonicalPath: string }>;
  baseline?: Map<string, string | undefined>;
}): Map<string, string> {
  const configDir = path.dirname(params.configPath);
  const shadowDir = path.dirname(params.shadowConfig);
  const inputs = new Map([[params.configPath, params.shadowConfig]]);
  for (const [file, { raw, canonicalPath }] of params.files) {
    const relative = path.relative(configDir, file);
    // An absolute alias stays inside the private tree at its admitted canonical location.
    const within =
      relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    const target = path.join(
      shadowDir,
      within ? relative : path.relative(fs.realpathSync(configDir), canonicalPath),
    );
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, raw, { mode: fs.statSync(file).mode & 0o7777 });
    params.baseline?.set(target, fileStamp(target));
    inputs.set(file, target);
  }
  return inputs;
}
