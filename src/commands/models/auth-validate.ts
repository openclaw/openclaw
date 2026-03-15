/**
 * CLI command to validate auth-profiles.json
 *
 * @see https://github.com/openclaw/openclaw/issues/26842
 */

import fs from "node:fs";
import type { ZodIssue } from "zod";
import { resolveAuthStorePath } from "../../agents/auth-profiles/paths.js";
import { safeValidateAuthProfileStore } from "../../agents/auth-profiles/schema.js";
import type { RuntimeEnv } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";

export interface ModelsAuthValidateOptions {
  file?: string;
  agent?: string;
  json?: boolean;
}

export async function modelsAuthValidateCommand(
  opts: ModelsAuthValidateOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const filePath = opts.file ?? resolveAuthStorePath(opts.agent);

  // Check file exists
  if (!fs.existsSync(filePath)) {
    if (opts.json) {
      runtime.log(
        JSON.stringify({ valid: false, file: filePath, error: `File not found: ${filePath}` }),
      );
    } else {
      runtime.log(theme.error(`File not found: ${filePath}`));
    }
    process.exitCode = 1;
    return;
  }

  // Read and parse JSON
  let rawData: unknown;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    rawData = JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      runtime.log(
        JSON.stringify({ valid: false, file: filePath, error: `Invalid JSON: ${message}` }),
      );
    } else {
      runtime.log(theme.error(`Invalid JSON in ${filePath}: ${message}`));
    }
    process.exitCode = 1;
    return;
  }

  // Validate against schema
  const result = safeValidateAuthProfileStore(rawData);

  if (result.success) {
    const profileCount = Object.keys(result.data.profiles).length;
    if (opts.json) {
      runtime.log(
        JSON.stringify({
          valid: true,
          file: filePath,
          version: result.data.version,
          profileCount,
          profiles: Object.keys(result.data.profiles),
        }),
      );
    } else {
      runtime.log(theme.success(`Valid auth-profiles.json`));
      runtime.log(theme.muted(`  File: ${filePath}`));
      runtime.log(theme.muted(`  Version: ${result.data.version}`));
      runtime.log(theme.muted(`  Profiles: ${profileCount}`));
      for (const [id, profile] of Object.entries(result.data.profiles)) {
        runtime.log(theme.muted(`    - ${id} (${profile.provider}, ${profile.type})`));
      }
    }
  } else {
    const errors = result.error.issues.map((issue: ZodIssue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    }));

    if (opts.json) {
      runtime.log(JSON.stringify({ valid: false, file: filePath, errors }));
    } else {
      runtime.log(theme.error(`Invalid auth-profiles.json: ${filePath}`));
      runtime.log("");
      for (const err of errors) {
        const pathStr = err.path || "(root)";
        runtime.log(theme.error(`  ${pathStr}: ${err.message}`));
      }
      runtime.log("");
      runtime.log(theme.muted("Common mistakes:"));
      runtime.log(theme.muted('  - Using "mode" instead of "type"'));
      runtime.log(theme.muted('  - Using "apiKey" instead of "key"'));
      runtime.log(theme.muted('  - Wrapping in "auth": {} (config format vs store format)'));
      runtime.log(theme.muted("  - Missing required fields (provider, type)"));
    }
    process.exitCode = 1;
  }
}
