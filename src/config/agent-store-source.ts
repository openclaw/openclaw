import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  listAgentIds,
  readAgentRosterProperty,
  resolveEffectiveAgentDir,
} from "../agents/agent-scope-config.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveUserPath } from "../utils.js";
import { cloneEnvWithPlatformSemantics } from "./config-env-vars.js";
import {
  coerceConfig,
  normalizeConfigIoDeps,
  parseConfigJson5,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
} from "./io.read-helpers.js";
import { resolveConfigPath } from "./paths.js";
import { resolveSessionStorePathCore } from "./sessions/paths.js";
import { listSqliteTargetCandidatePathsForSessionStorePath } from "./sessions/session-sqlite-target-paths.js";
import { listConfiguredSessionStoreAgentIds } from "./sessions/targets-configured-agents.js";

/** Inspect authored SQLite locators without runtime config, plugin loading, or state access. */
export function readAgentStorePathsFromConfig(env: NodeJS.ProcessEnv, stateDir: string): string[] {
  const readEnv = cloneEnvWithPlatformSemantics(env);
  readEnv.OPENCLAW_STATE_DIR = stateDir;
  const configPath = resolveConfigPath(readEnv, stateDir);
  let raw = "{}";
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  const parsed = parseConfigJson5(raw);
  if (!parsed.ok) {
    throw new Error(`Cannot parse agent storage configuration at ${configPath}.`);
  }
  const deps = normalizeConfigIoDeps({ env: readEnv, configPath, observe: false });
  const source = resolveConfigIncludesForRead(parsed.parsed, configPath, deps);
  if (
    !isRecord(source) ||
    ["agents", "session"].some((key) => source[key] !== undefined && !isRecord(source[key]))
  ) {
    throw new Error(`Invalid agent storage configuration at ${configPath}.`);
  }
  const roster = readAgentRosterProperty(source);
  const hasValidStorageLocator = (entry: unknown) =>
    isRecord(entry) && (entry.agentDir === undefined || typeof entry.agentDir === "string");
  if (
    roster &&
    (roster.kind === "entries"
      ? !isRecord(roster.value) ||
        Object.values(roster.value).some((entry) => !hasValidStorageLocator(entry))
      : !Array.isArray(roster.value) ||
        roster.value.some(
          (entry) => !hasValidStorageLocator(entry) || typeof entry.id !== "string",
        ))
  ) {
    throw new Error(`Invalid agent roster at ${configPath}.`);
  }
  if (
    isRecord(source.session) &&
    source.session.store !== undefined &&
    typeof source.session.store !== "string"
  ) {
    throw new Error(`Invalid session storage configuration at ${configPath}.`);
  }
  const resolved = resolveConfigForRead(source, readEnv);
  if (
    resolved.envWarnings.some(
      (warning) =>
        warning.configPath === "session.store" ||
        warning.configPath.endsWith(".agentDir") ||
        (warning.configPath.startsWith("agents.list[") && warning.configPath.endsWith(".id")) ||
        warning.configPath === "acp.defaultAgent" ||
        warning.configPath.startsWith("acp.allowedAgents") ||
        warning.configPath.endsWith(".runtime.type") ||
        warning.configPath.endsWith(".runtime.acp.agent"),
    )
  ) {
    throw new Error(
      `Unresolved environment reference in agent storage configuration at ${configPath}.`,
    );
  }
  const config = coerceConfig(resolved.resolvedConfigRaw);
  const agentIds = listAgentIds(config);
  const paths = new Set(
    agentIds.map((agentId) =>
      path.join(
        resolveEffectiveAgentDir(config, agentId, { env: readEnv }),
        "openclaw-agent.sqlite",
      ),
    ),
  );
  const stores = new Set(
    listConfiguredSessionStoreAgentIds(config).map((agentId) =>
      resolveSessionStorePathCore(config.session?.store, { agentId, env: readEnv }),
    ),
  );
  for (const store of stores) {
    for (const candidate of listSqliteTargetCandidatePathsForSessionStorePath(store)) {
      paths.add(candidate);
    }
  }
  for (const directory of [readEnv.OPENCLAW_AGENT_DIR, readEnv.PI_CODING_AGENT_DIR]) {
    if (directory?.trim()) {
      paths.add(path.join(resolveUserPath(directory, readEnv), "openclaw-agent.sqlite"));
    }
  }
  return [...paths];
}
