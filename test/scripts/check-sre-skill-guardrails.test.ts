import { describe, expect, it } from "vitest";
import { validateMorphoSreSkillText } from "../../scripts/check-sre-skill-guardrails.ts";

const VALID_SKILL = `
## Hard Rules
- Hard preflight before diagnosis:
  - verify binaries and PATH first: \`command -v kubectl aws jq git gh\`
- Shell portability:
  - do not use Bash-only syntax unless command is explicitly wrapped with \`bash -lc '...'\`
- No root-cause ranking before one successful live check.
- if user provides an exact query, event ID, trace ID, address, or says the prior answer is wrong, replay that exact artifact first
- use Sentry event IDs only after a live lookup, or explicitly say creds are unavailable
- do not reuse a prior incident unless operation name, schema object, failing fields, chain, and address pattern match
- do not send progress-only replies such as \`On it\`, \`Found it\`, or \`Let me verify\`
- Before claiming repo/tool access is unavailable, run one live probe (\`gh repo view <owner/repo>\` or the target helper in dry-run mode) and quote the exact error.
- If a human questions the proposed fix or PR in-thread, re-open RCA with fresh live evidence; do not repeat the old theory or go silent.
- If current code or live evidence disproves an earlier theory, say \`Disproved theory:\` before proposing the replacement cause or PR.
- RBAC-aware fallback:
  - if \`pods/exec forbidden\` appears, stop retrying \`kubectl exec\`
- Before broad repo/code reads, load at least one retrieval surface relevant to the incident:
  - \`knowledge-index.md\`
  - \`runbook-map.md\`

## Rewards / Provider Incidents
- before naming a stale-row/write-path cause or opening a PR, include one live DB row/provenance fact for the affected reward entity
- the reply must also name one exact consuming repo/path fact for the active code path
- if the same reward token appears on both supply and borrow for one market, first quote the live reward row/provenance

## Single-Vault API / GraphQL Data Incidents
- use \`single-vault-graphql-evidence.sh\` before RCA ranking when possible
- compare against one healthy control vault on the same chain
- compare public surfaces:
  - \`vaultV2ByAddress\`
  - \`vaultV2s\`
  - \`vaultV2transactions\`
- explicitly retract the outdated theory when new evidence contradicts a prior theory
- do not call an ingestion/provenance root cause confirmed until you add one DB row/provenance fact and one job-path or simulation fact

## Blocked Mode Reply Contract
- \`*Evidence:* <exact command> -> <exact error>\`
`;

describe("check-sre-skill-guardrails", () => {
  it("accepts a skill text with all required guardrails", () => {
    expect(validateMorphoSreSkillText(VALID_SKILL)).toEqual([]);
  });

  it("reports missing guardrails", () => {
    const issues = validateMorphoSreSkillText("## Hard Rules\n- Diagnose first.");
    expect(issues.map((issue) => issue.id)).toContain("hard-preflight");
    expect(issues.map((issue) => issue.id)).toContain("blocked-mode");
    expect(issues.map((issue) => issue.id)).toContain("rback-fallback");
    expect(issues.map((issue) => issue.id)).toContain("retrieval-before-repo");
  });
});
