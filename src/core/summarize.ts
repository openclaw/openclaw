import type { ReviewFinding, ToolAudience } from "./types.js";

export function summarizeFindingForAudience(
  finding: ReviewFinding,
  audience: ToolAudience,
): string {
  switch (audience) {
    case "founder":
      return `Business risk: ${finding.finding} (${finding.severity}) can affect ${finding.affected_area}. ${finding.why_it_matters}`;
    case "support":
      return `Support note: ${finding.finding}. Watch ${finding.affected_area} and use the recommended fix path before closing the issue.`;
    case "auditor":
      return `Audit summary: ${finding.finding} (${finding.severity}) on ${finding.affected_area}. Evidence: ${finding.evidence.join("; ")}`;
    case "engineer":
    default:
      return `Engineering summary: ${finding.finding} (${finding.severity}) on ${finding.affected_area}. Fix next: ${finding.recommended_fix.join(" ")}`;
  }
}
