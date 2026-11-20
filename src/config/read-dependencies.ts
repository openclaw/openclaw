import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { resolveChannelConfigActivationFacts } from "./channel-config-activation.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type Reader = "metadata" | "sessions";
type Dependency = Reader | "both" | "other" | "unknown";

// Model metadata reads catalog/auth/runtime resolution and agent policy.
// Session rows also read workspace, sandbox, execution and response presentation.
// Exhaustiveness makes a new schema root require an explicit reader decision;
// unknown dependencies (including plugin-owned settings) retain invalidation.
const dependencies: Record<string, Dependency> = {
  $schema: "other",
  meta: "metadata",
  env: "both",
  wizard: "other",
  diagnostics: "other",
  logging: "other",
  update: "other",
  telemetry: "other",
  browser: "other",
  ui: "other",
  secrets: "both",
  auth: "both",
  accessGroups: "unknown",
  acp: "both",
  models: "both",
  nodeHost: "sessions",
  agents: "both",
  worktreeRoot: "sessions",
  repositoryBranchPrefix: "sessions",
  worktreeAcceleration: "sessions",
  worktreeMaxCount: "sessions",
  tools: "both",
  security: "unknown",
  bindings: "unknown",
  broadcast: "unknown",
  attachments: "unknown",
  messages: "both",
  tts: "both",
  commands: "other",
  approvals: "unknown",
  session: "both",
  cron: "unknown",
  transcripts: "unknown",
  hooks: "both",
  channels: "both",
  discovery: "unknown",
  talk: "unknown",
  gateway: "unknown",
  cloudWorkers: "both",
  database: "unknown",
  storage: "unknown",
  desktop: "unknown",
  memory: "unknown",
  mcp: "unknown",
  // refreshConfigReloadSkills publishes command eligibility after every commit,
  // including arbitrary requires.config paths; metadata consumes its skills version.
  skills: "other",
  // Plugin-derived rows follow completed catalog publications.
  plugins: "metadata",
  surfaces: "unknown",
  proxy: "unknown",
  audit: "unknown",
} satisfies Record<keyof OpenClawConfig, Dependency>;

export function configPathAffectsReader(path: string, reader: Reader): boolean {
  if (path === "meta.lastTouchedVersion") {
    return false;
  }
  const root = path.split(".")[0]!;
  const dependency = Object.hasOwn(dependencies, root) ? dependencies[root] : "unknown";
  return dependency === reader || dependency === "both" || dependency === "unknown";
}

/** The same dependency decision scopes both publication keys and client refreshes. */
export function configPathAffectsConversation(path: string): boolean {
  return configPathAffectsReader(path, "metadata") || configPathAffectsReader(path, "sessions");
}

export function projectConfigReadDependencies(config: OpenClawConfig, reader: Reader) {
  const values = Object.fromEntries(
    Object.entries(config).filter(([root]) => configPathAffectsReader(root, reader)),
  );
  if (reader === "metadata") {
    const { lastTouchedVersion: _version, ...meta } = config.meta ?? {};
    values.meta = meta;
  } else {
    const { auth, ...gateway } = config.gateway ?? {};
    const { identityScopes: _identityScopes, ...gatewayAuth } = auth ?? {};
    const { realtime, ...talk } = config.talk ?? {};
    const { model: _model, ...realtimeConfig } = realtime ?? {};
    values.gateway = { ...gateway, auth: gatewayAuth };
    values.talk = { ...talk, realtime: realtimeConfig };
    // Consume the readers' facts, not a second list of channel model/activation fields.
    values.channels = {
      activation: resolveChannelConfigActivationFacts(config),
      models: collectConfiguredModelRefs({ channels: config.channels }),
    };
  }
  return { ...values, agents: config.agents };
}
