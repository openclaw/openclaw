import { mergeMissing } from "./merge-missing.js";
import { cloneConfigWithResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Presets supply configuration defaults, never an authorization or host-policy override. */
export function applySecurityPresetDefaults(config: OpenClawConfig): OpenClawConfig {
  const preset = config.security?.preset ?? "personal";
  const corporate = preset === "corporate";
  const exec = config.tools?.exec;
  // A legacy security/ask pair is one explicit policy, not missing pieces of a mode.
  const hasExecPolicy =
    exec?.mode !== undefined || exec?.security !== undefined || exec?.ask !== undefined;
  const defaults: OpenClawConfig = {
    security: { preset },
    agents: {
      defaults: {
        sandbox: corporate
          ? { mode: "all", scope: "session", workspaceAccess: "rw", docker: { network: "none" } }
          : { mode: "off" },
      },
    },
    messages: {
      queue: {
        allowCollaborativeSteering: !corporate,
        collaborativeSteeringFallback: corporate ? "reject" : "queue",
      },
    },
    tools: {
      exec: {
        ...(!hasExecPolicy ? { mode: corporate ? "ask" : "full" } : {}),
        applyPatch: { workspaceOnly: corporate },
        strictInlineEval: corporate,
      },
      fs: { workspaceOnly: corporate },
      elevated: { enabled: !corporate },
      sessions: { visibility: corporate ? "tree" : "all" },
      agentToAgent: { enabled: !corporate },
      message: {
        crossContext: { allowWithinProvider: !corporate, allowAcrossProviders: !corporate },
      },
    },
    ...(corporate ? { session: { dmScope: "per-account-channel-peer" } } : {}),
  };
  const next = cloneConfigWithResolutionFacts(config);
  mergeMissing(next, defaults);
  return next;
}
