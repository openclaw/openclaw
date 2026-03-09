import { describe, expect, it } from "vitest";
import { validateMorphoSreSkillText } from "../../scripts/check-sre-skill-guardrails.ts";

const VALID_SKILL = `
## Hard Rules
- Hard preflight before diagnosis:
  - verify binaries and PATH first: \`command -v kubectl aws jq git gh\`
- Shell portability:
  - do not use Bash-only syntax unless command is explicitly wrapped with \`bash -lc '...'\`
- No root-cause ranking before one successful live check.
- RBAC-aware fallback:
  - if \`pods/exec forbidden\` appears, stop retrying \`kubectl exec\`
- Before broad repo/code reads, load at least one retrieval surface relevant to the incident:
  - \`knowledge-index.md\`
  - \`runbook-map.md\`

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
