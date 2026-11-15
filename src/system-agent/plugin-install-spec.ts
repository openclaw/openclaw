import { resolvePluginInstallSourcePlan } from "../plugins/install-source-plan.js";

export function validateSystemAgentPluginInstallSpec(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed) {
    return "Plugin install spec is required.";
  }
  if (/\s/.test(trimmed)) {
    return "OpenClaw plugin install accepts one npm or ClawHub package spec.";
  }
  if (/^(?:\.{1,2}\/|\/|~\/|file:|git(?:\+ssh|\+https)?:|https?:)/i.test(trimmed)) {
    // OpenClaw does not install local paths or URLs; those can execute arbitrary package code.
    return "OpenClaw plugin install accepts npm or ClawHub package specs only.";
  }
  const plan = resolvePluginInstallSourcePlan({ raw: trimmed, mode: "install" });
  if (!plan.ok) {
    return plan.error;
  }
  if (plan.acknowledgement) {
    return "OpenClaw installs only ClawHub, bundled, or official-catalog plugins. Use `openclaw plugins install <spec>` in a trusted shell to review an arbitrary executable source.";
  }
  return null;
}
