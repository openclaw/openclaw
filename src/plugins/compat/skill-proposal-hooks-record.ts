import type { PluginCompatRecord } from "./types.js";

export const SKILL_PROPOSAL_HOOKS_COMPAT_RECORD = {
  code: "removed-skill-proposal-hooks",
  status: "removed",
  owner: "sdk",
  introduced: "2026-09-29",
  // Removal landed 2026-10-08 (#161057); the prior day was the final compatibility day.
  removeAfter: "2026-10-07",
  docsPath: "/plugins/sdk-migration/removed-surfaces#skill-workshop-proposal-hooks",
  surfaces: [
    'api.on("skill_proposal_evaluate", ...)',
    'api.on("skill_proposal_changed", ...)',
    "openclaw/plugin-sdk/plugin-entry.PluginHookSkillProposalEvaluateEvent",
    "openclaw/plugin-sdk/plugin-entry.PluginHookSkillProposalEvaluateResult",
    "openclaw/plugin-sdk/plugin-entry.PluginHookSkillProposalEvaluationOutcome",
    "openclaw/plugin-sdk/plugin-entry.PluginHookSkillProposalChangedEvent",
    "openclaw/plugin-sdk/plugin-entry.PluginHookSkillProposalKind",
    "openclaw/plugin-sdk/plugin-entry.PluginHookSkillEvaluationFinding",
    "openclaw/plugin-sdk/plugin-entry.PluginHookSkillBundleFile",
    "openclaw/plugin-sdk/plugin-entry.PluginHookSkillBundleSnapshot",
    "PluginHookSkillChangedEvent.proposal",
  ],
  diagnostics: ["plugin compatibility registry and migration guide"],
  tests: ["src/plugins/compat/registry.test.ts"],
  releaseNote:
    "The Skill Workshop `skill_proposal_evaluate` and `skill_proposal_changed` plugin hooks were removed with Workshop proposals; Workshop now applies changes immediately with restorable versions.",
} as const satisfies PluginCompatRecord;
