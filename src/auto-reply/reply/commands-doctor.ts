import { getUpdateCheckResult } from "../../commands/status.update.js";
import { loadConfig } from "../../config/io.js";
import { validateConfigObject } from "../../config/validation.js";
import { logVerbose } from "../../globals.js";
import { buildChannelSummary } from "../../infra/channel-summary.js";
import { buildContextReply } from "./commands-context-report.js";
import type { CommandHandler } from "./commands-types.js";

// ─── /doctor ──────────────────────────────────────────────────────────

export const handleDoctorCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/doctor") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /doctor from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const lines: string[] = ["🩺 **System Doctor**", ""];

  // 1. Config validation
  try {
    const cfg = loadConfig();
    const result = validateConfigObject(cfg);
    if (result.ok) {
      lines.push("✅ Config: valid");
    } else {
      lines.push(`⚠️ Config: ${result.issues.length} issue(s)`);
      for (const issue of result.issues.slice(0, 5)) {
        lines.push(`  - ${issue.path}: ${issue.message}`);
      }
    }
  } catch (err) {
    lines.push(`❌ Config: failed to load — ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Model reachability (basic check)
  lines.push(`✅ Model: ${params.provider}/${params.model}`);
  lines.push(`   Context: ${params.contextTokens} tokens`);

  // 3. Channel health
  try {
    const channelLines = await buildChannelSummary(params.cfg, { colorize: false });
    if (channelLines.length > 0) {
      const degradedCount = channelLines.filter((l) => l.includes("degraded")).length;
      const connectedCount = channelLines.filter(
        (l) => l.includes("linked") || l.includes("configured"),
      ).length;
      if (degradedCount > 0) {
        lines.push(`⚠️ Channels: ${degradedCount} degraded, ${connectedCount} healthy`);
      } else {
        lines.push(`✅ Channels: ${connectedCount} configured`);
      }
    } else {
      lines.push("ℹ️ Channels: none configured");
    }
  } catch (err) {
    lines.push(`❌ Channels: check failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Git / update check
  try {
    const updateResult = await getUpdateCheckResult({
      timeoutMs: 6000,
      fetchGit: false,
      includeRegistry: false,
    });
    const git = updateResult.git;
    const gitParts: string[] = [];
    if (git) {
      if (git.dirty) {
        gitParts.push("dirty");
      }
      if (git.behind && git.behind > 0) {
        gitParts.push(`${git.behind} behind`);
      }
      if (git.ahead && git.ahead > 0) {
        gitParts.push(`${git.ahead} ahead`);
      }
      if (git.branch) {
        gitParts.push(`branch: ${git.branch}`);
      }
    }
    if (gitParts.length === 0) {
      lines.push("✅ Git: clean");
    } else {
      const hasIssue = git?.dirty || (git?.behind && git.behind > 0);
      lines.push(`${hasIssue ? "⚠️" : "✅"} Git: ${gitParts.join(", ")}`);
    }

    const deps = updateResult.deps;
    if (deps) {
      if (deps.status === "ok") {
        lines.push("✅ Dependencies: up to date");
      } else {
        lines.push(`⚠️ Dependencies: ${deps.status}${deps.reason ? ` — ${deps.reason}` : ""}`);
      }
    }
  } catch (err) {
    lines.push(`❌ Update check: failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Runtime info
  lines.push("");
  lines.push(`Node: ${process.version}`);
  lines.push(`Platform: ${process.platform} ${process.arch}`);
  lines.push(`Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS`);

  return { shouldContinue: false, reply: { text: lines.join("\n") } };
};

// ─── /prompt ──────────────────────────────────────────────────────────

export const handlePromptReportCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/prompt") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /prompt from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Reuse the context report — override commandBodyNormalized so parseContextArgs
  // inside buildContextReply returns "detail" instead of seeing "/prompt".
  const overridden = {
    ...params,
    command: { ...params.command, commandBodyNormalized: "/context detail" },
  };
  return { shouldContinue: false, reply: await buildContextReply(overridden) };
};

// ─── /cache ───────────────────────────────────────────────────────────

export const handleCacheTraceCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/cache") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /cache from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const report = params.sessionEntry?.systemPromptReport;
  if (!report) {
    return {
      shouldContinue: false,
      reply: {
        text: "ℹ️ No cache trace data available for this session yet. Send a message first, then try again.",
      },
    };
  }

  const lines: string[] = ["📊 **Cache Trace**", ""];

  lines.push(`Session: ${params.sessionKey}`);
  lines.push(`Model: ${params.provider}/${params.model}`);
  lines.push(`Context: ${params.contextTokens} tokens`);
  lines.push("");

  if (report.systemPrompt) {
    lines.push(
      `System prompt: ${report.systemPrompt.chars} chars (~${Math.ceil(report.systemPrompt.chars / 4)} tokens)`,
    );
    if (report.systemPrompt.projectContextChars) {
      lines.push(`  Project context: ${report.systemPrompt.projectContextChars} chars`);
    }
  }

  if (report.tools && report.tools.entries.length > 0) {
    lines.push(`Tools: ${report.tools.entries.length} (${report.tools.schemaChars} schema chars)`);
  }

  if (report.skills && report.skills.entries.length > 0) {
    lines.push(`Skills: ${report.skills.entries.map((s) => s.name).join(", ")}`);
  }

  if (report.injectedWorkspaceFiles && report.injectedWorkspaceFiles.length > 0) {
    const injected = report.injectedWorkspaceFiles.filter((f) => !f.missing);
    lines.push(`Workspace files: ${injected.length} injected`);
    for (const file of injected.slice(0, 5)) {
      lines.push(
        `  - ${file.name}: ${file.injectedChars ?? 0} chars${file.truncated ? " (truncated)" : ""}`,
      );
    }
    if (injected.length > 5) {
      lines.push(`  ... and ${injected.length - 5} more`);
    }
  }

  return { shouldContinue: false, reply: { text: lines.join("\n") } };
};
