import path from "node:path";
import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { timestampMsToIsoFileStamp } from "@openclaw/normalization-core/number-coercion";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MigrationProviderContext } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveHomeDir } from "../../utils.js";

/** Builds a migration logger that keeps JSON stdout machine-readable. */
export function createMigrationLogger(runtime: RuntimeEnv, opts: { json?: boolean } = {}) {
  const info = opts.json ? runtime.error : runtime.log;
  return {
    debug: (message: string) => {
      if (process.env.OPENCLAW_VERBOSE === "1") {
        info(message);
      }
    },
    info: (message: string) => info(message),
    warn: (message: string) => runtime.error(message),
    error: (message: string) => runtime.error(message),
  };
}

export function buildMigrationReportDir(
  providerId: string,
  stateDir: string,
  nowMs = Date.now(),
): string {
  const stamp = timestampMsToIsoFileStamp(nowMs);
  return path.join(stateDir, "migration", providerId, stamp);
}

/**
 * Pre-migration backup directory for imports that the user did not start from a shell
 * (Gateway, Control UI, onboarding). The CLI keeps `openclaw backup create`'s cwd default;
 * a service's cwd is incidental, so use the home folder the backup already falls back to.
 */
export function resolveUnattendedMigrationBackupOutput(): string {
  return `${resolveHomeDir() ?? path.dirname(resolveStateDir())}${path.sep}`;
}

/** Resolves an explicit migration owner without allowing typo-created agent stores. */
function resolveMigrationTargetAgentId(
  config: OpenClawConfig,
  rawAgentId: string | undefined,
): string | undefined {
  const raw = rawAgentId?.trim();
  if (rawAgentId !== undefined && !raw) {
    throw new Error("--agent must not be blank");
  }
  if (!raw) {
    return undefined;
  }
  if (!isValidAgentId(raw)) {
    throw new Error(`Invalid agent id "${raw}".`);
  }
  const agentId = normalizeAgentId(raw);
  return resolveConfiguredAgentId(config, agentId);
}

export function buildMigrationContext(params: {
  source?: string;
  targetAgentId?: string;
  itemKinds?: readonly string[];
  includeSecrets?: boolean;
  overwrite?: boolean;
  providerOptions?: Record<string, unknown>;
  backupPath?: string;
  configOverride?: OpenClawConfig;
  runtime: RuntimeEnv;
  reportDir?: string;
  json?: boolean;
}): MigrationProviderContext {
  const config = params.configOverride ?? loadConfig();
  const stateDir = resolveStateDir();
  return {
    config,
    stateDir,
    targetAgentId: resolveMigrationTargetAgentId(config, params.targetAgentId),
    itemKinds: params.itemKinds,
    source: params.source,
    includeSecrets: Boolean(params.includeSecrets),
    overwrite: Boolean(params.overwrite),
    providerOptions: params.providerOptions,
    backupPath: params.backupPath,
    reportDir: params.reportDir,
    logger: createMigrationLogger(params.runtime, { json: params.json }),
  };
}
