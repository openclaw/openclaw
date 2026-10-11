import { tryResolveSoleAgentId } from "../agents/agent-scope.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type { HealthFinding } from "./health-checks.js";

export const bootstrapSizeCheck: Omit<DoctorHealthCheck, "kind" | "source"> = {
  id: "core/doctor/bootstrap-size",
  description: "Workspace bootstrap files fit within configured injection limits.",
  async detect(ctx) {
    if (!ctx.cwd) {
      return [];
    }
    const { collectBootstrapFileSize } = await import("../commands/doctor-bootstrap-size.js");
    const { isFixedUserCapFile } = await import("../agents/bootstrap-budget.js");
    const { USER_BOOTSTRAP_MAX_CHARS } =
      await import("../agents/embedded-agent-helpers/bootstrap.js");
    const workspaceDir = ctx.cwd;
    const { analysis } = await collectBootstrapFileSize(
      ctx.cfg,
      workspaceDir,
      tryResolveSoleAgentId(ctx.cfg),
    );
    // USER.md's fixed cap makes per-file tuning advice a dead end: name the cap
    // and the compaction action instead, matching the interactive Doctor note.
    const fixedCapHint = `Reduce the file size; USER.md has a fixed ${USER_BOOTSTRAP_MAX_CHARS.toLocaleString("en-US")}-character bootstrap cap that \`bootstrapMaxChars\` cannot raise.`;
    const findings: HealthFinding[] = [];
    for (const file of analysis.truncatedFiles) {
      let fixHint =
        "Reduce the file size or tune `agents.entries.*.bootstrapMaxChars` / `bootstrapTotalMaxChars` for this agent, or the corresponding `agents.defaults.*` fallback.";
      if (file.causes.includes("per-file-limit") && isFixedUserCapFile(file)) {
        fixHint = fixedCapHint;
        if (file.causes.includes("total-limit")) {
          fixHint +=
            " Also reduce total bootstrap size or tune `agents.entries.*.bootstrapTotalMaxChars` for this agent, or `agents.defaults.bootstrapTotalMaxChars` as fallback.";
        }
      }
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        category: "recommended",
        docsUrl: "https://docs.openclaw.ai/concepts/agent-workspace",
        severity: "warning",
        message: `${file.name} exceeds bootstrap limits and will be truncated.`,
        path: file.path,
        fixHint,
      });
    }
    for (const file of analysis.nearLimitFiles) {
      if (file.truncated) {
        continue;
      }
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        category: "recommended",
        docsUrl: "https://docs.openclaw.ai/concepts/agent-workspace",
        severity: "info",
        message: `${file.name} is near the configured bootstrap file limit.`,
        path: file.path,
        fixHint: isFixedUserCapFile(file)
          ? fixedCapHint
          : "Reduce the file size or tune `agents.entries.*.bootstrapMaxChars` for this agent, or `agents.defaults.bootstrapMaxChars` as fallback, for per-file limits.",
      });
    }
    if (analysis.totalNearLimit) {
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        category: "recommended",
        docsUrl: "https://docs.openclaw.ai/concepts/agent-workspace",
        severity: analysis.hasTruncation ? "warning" : "info",
        message: "Total bootstrap context is near the configured total limit.",
        path: workspaceDir,
        fixHint:
          "Reduce bootstrap file sizes or tune `agents.entries.*.bootstrapTotalMaxChars` for this agent, or `agents.defaults.bootstrapTotalMaxChars` as fallback.",
      });
    }
    return findings;
  },
};
