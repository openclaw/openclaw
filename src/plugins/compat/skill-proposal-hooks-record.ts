import type { PluginCompatRecord } from "./types.js";

export const SKILL_PROPOSAL_HOOKS_COMPAT_RECORD = {
  code: "removed-skill-proposal-hooks",
  status: "removed",
  owner: "sdk",
  introduced: "2026-09-29",
  docsPath: "/plugins/sdk-migration/removed-surfaces#skill-workshop-proposal-hooks",
  surfaces: [
    'api.on("skill_proposal_evaluate", ...)',
    'api.on("skill_proposal_changed", ...)',
    "PluginHookSkillProposalEvaluateEvent",
    "PluginHookSkillProposalEvaluateResult",
    "PluginHookSkillProposalEvaluationOutcome",
    "PluginHookSkillProposalChangedEvent",
    "PluginHookSkillProposalKind",
    "PluginHookSkillEvaluationFinding",
    "PluginHookSkillBundleFile",
    "PluginHookSkillBundleSnapshot",
    "PluginHookSkillChangedEvent.proposal",
  ],
  diagnostics: ["plugin compatibility registry and migration guide"],
  tests: ["src/plugins/compat/registry.test.ts"],
  releaseNote:
    "The Skill Workshop `skill_proposal_evaluate` and `skill_proposal_changed` plugin hooks were removed with Workshop proposals; Workshop now applies changes immediately with restorable versions.",
} as const satisfies PluginCompatRecord;
