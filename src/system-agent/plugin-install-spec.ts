import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { parseGitPluginSpec } from "../plugins/git-install.js";
import {
  pluginInstallRequiresLocalHost,
  resolvePluginInstallSourcePlan,
} from "../plugins/install-source-plan.js";

export function validateSystemAgentPluginInstallSpec(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed) {
    return "Plugin install spec is required.";
  }
  if (/\s/.test(trimmed)) {
    return "OpenClaw plugin install accepts one npm, ClawHub, or git: package spec.";
  }
  if (/^(?:\.{1,2}\/|\/|~\/|file:|https?:)/i.test(trimmed)) {
    return "OpenClaw plugin install accepts npm, ClawHub, or remote git: specs, not local paths or archive URLs.";
  }
  const plan = resolvePluginInstallSourcePlan({ raw: trimmed, mode: "install" });
  if (!plan.ok) {
    return plan.error;
  }
  if (pluginInstallRequiresLocalHost(plan.request)) {
    return "OpenClaw plugin install requires a remote package source. Use plugin_activate_artifact for a task-authored plugin archive.";
  }
  return null;
}

/** Keep operational credentials private while preserving the reviewed Git host/ref. */
export function redactSystemAgentPluginInstallSpec(spec: string): string {
  const git = parseGitPluginSpec(spec);
  if (!git) {
    return redactSensitiveUrlLikeString(spec);
  }
  const url = redactSensitiveUrlLikeString(git.url);
  return url === git.url ? spec : `git:${url}${git.ref ? `@${git.ref}` : ""}`;
}
