import nodePath from "node:path";
import { resolveConfigEnvVars } from "../../../../src/config/env-substitution.js";
import { resolveConfigIncludes } from "../../../../src/config/includes.js";
import { redactConfigSnapshot } from "../../../../src/config/redact-snapshot.js";
import { buildConfigSchemaCore } from "../../../../src/config/schema.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { ConfigSnapshot } from "../../api/types.ts";

// Every snapshot here goes through the Gateway's own include, env and redaction code, so the form
// is classified from exactly what config.get would send it.
const { uiHints: hints } = buildConfigSchemaCore();
const ENV = { SET_TOKEN: "env-token-value-not-real", OTHER_TOKEN: "other-env-value-not-real" };

export function gatewaySnapshot(
  authored: Record<string, unknown>,
  files: Record<string, unknown> = {},
): ConfigSnapshot {
  const included = resolveConfigIncludes(authored, "/fixture/openclaw.json", {
    readFile: (file) => JSON.stringify(files[nodePath.basename(file)]),
    parseJson: JSON.parse,
  });
  const warnings: Array<{ path: string; message: string }> = [];
  // SAFETY: Synthetic authored fixtures only use OpenClaw configuration fields.
  const resolved = resolveConfigEnvVars(included, ENV, {
    onMissing: ({ varName, configPath }) =>
      warnings.push({
        path: configPath,
        message: `Missing env var "${varName}" - feature using this value will be unavailable`,
      }),
  }) as OpenClawConfig;
  const snapshot: ConfigFileSnapshot = {
    path: "/fixture/openclaw.json",
    ...(Object.keys(files).length > 0
      ? { includedPaths: Object.keys(files).map((file) => `/fixture/${file}`) }
      : {}),
    exists: true,
    raw: JSON.stringify(authored, null, 2),
    parsed: authored,
    sourceConfig: resolved,
    resolved,
    config: resolved,
    runtimeConfig: resolved,
    valid: true,
    hash: "fixture",
    issues: [],
    warnings,
    legacyIssues: [],
  };
  // SAFETY: The redacted snapshot is the config.get payload the UI types as ConfigSnapshot.
  return redactConfigSnapshot(snapshot, hints) as unknown as ConfigSnapshot;
}
