import * as p from "@clack/prompts";
import chalk from "chalk";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";

type ConfigIssue = {
  severity: "error" | "warning";
  message: string;
  path?: string;
  fix?: () => Promise<void>;
};

export async function runConfigDoctor() {
  p.intro(chalk.cyan("🦞 OpenClaw Config Doctor"));

  const s = p.spinner();
  s.start("Analyzing configuration...");

  const snapshot = await readConfigFileSnapshot();
  const issues: ConfigIssue[] = [];

  // 1. Check Validity (Schema)
  if (!snapshot.valid) {
    for (const issue of snapshot.issues) {
      issues.push({
        severity: "error",
        message: `Schema violation: ${issue.message}`,
        path: issue.path,
      });
    }
  }

  const config = snapshot.config || {};

  // 2. Check Logical Issues (The "Nightmares")

  // Check: Primary Model Validation
  const primaryModel = config.agents?.defaults?.model?.primary;
  if (!primaryModel) {
    issues.push({
      severity: "error",
      message: "No primary model configured. Agents will fail to start.",
      path: "agents.defaults.model.primary",
      fix: async () => {
        const model = await p.text({
          message: "Enter a primary model ID (e.g., google/gemini-3-flash-preview):",
          placeholder: "google/gemini-3-flash-preview",
          validate: (value) => {
            if (!value) return "Model ID is required.";
          },
        });
        if (typeof model !== "string") return;
        
        if (!config.agents) config.agents = {};
        if (!config.agents.defaults) config.agents.defaults = {};
        if (!config.agents.defaults.model) config.agents.defaults.model = {};
        
        config.agents.defaults.model.primary = model;
      },
    });
  }

  // Check: Auth Profile for Primary Model
  if (primaryModel && typeof primaryModel === "string") {
    const provider = primaryModel.split("/")[0];
    const hasProfile = Object.values(config.auth?.profiles || {}).some(
      (p: any) => p.provider === provider || primaryModel.startsWith(p.provider)
    );
    
    if (!hasProfile) {
       issues.push({
        severity: "warning",
        message: `Primary model '${primaryModel}' has no matching auth profile for provider '${provider}'.`,
        path: "auth.profiles",
      });
    }
  }

  // Check: Rate Limit Safety (Smart Throttler)
  const isAnthropic = primaryModel?.includes("claude");
  const isGoogle = primaryModel?.includes("google");
  
  if ((isAnthropic || isGoogle) && !config.agents?.defaults?.maxRetries) {
     issues.push({
      severity: "warning",
      message: "Rate limit safeguards missing. You might get locked out (429 loops).",
      path: "agents.defaults.maxRetries",
      fix: async () => {
         if (!config.agents) config.agents = {};
         if (!config.agents.defaults) config.agents.defaults = {};
         
         config.agents.defaults.maxRetries = 10;
         config.agents.defaults.backoff = {
             kind: "exponential",
             startMs: 2000,
             maxMs: 60000
         };
      }
    });
  }

  s.stop("Analysis complete.");

  if (issues.length === 0) {
    p.outro(chalk.green("✅ Config is healthy! No issues found."));
    return;
  }

  p.note(
    issues.map(i => `${i.severity === "error" ? "🔴" : "🟡"} ${i.message} ${i.path ? chalk.dim(`(${i.path})`) : ""}`).join("\n"),
    `Found ${issues.length} issue${issues.length === 1 ? "" : "s"}`
  );

  const fixableIssues = issues.filter(i => !!i.fix);
  
  if (fixableIssues.length > 0) {
    const shouldFix = await p.confirm({
      message: `I can automatically fix ${fixableIssues.length} issue(s). Proceed?`,
    });

    if (shouldFix) {
      const fixSpinner = p.spinner();
      fixSpinner.start("Applying fixes...");
      
      for (const issue of fixableIssues) {
        if (issue.fix) await issue.fix();
      }
      
      // Write back to disk
      await writeConfigFile(config);
      
      fixSpinner.stop("Fixes applied.");
      p.outro(chalk.green(`✅ Updated config at ${shortenHomePath(snapshot.path)}. Restart OpenClaw to apply.`));
    } else {
      p.outro(chalk.yellow("Skipped fixes."));
    }
  } else {
    p.outro(chalk.yellow("No automatic fixes available for these issues. Please edit the config manually."));
  }
}
