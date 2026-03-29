import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { buildWorkspaceHookStatus } from "../hooks/hooks-status.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const SKIP_SELECTION = "__skip__";
const SELECT_ALL_SELECTION = "__all__";
const HOOK_OPTION_PREFIX = "hook:";

export async function setupInternalHooks(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "Hooks let you automate actions when agent commands are issued.",
      "Example: Save session context to memory when you issue /new or /reset.",
      "",
      "Learn more: https://docs.openclaw.ai/automation/hooks",
    ].join("\n"),
    "Hooks",
  );

  // Discover available hooks using the hook discovery system
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const report = buildWorkspaceHookStatus(workspaceDir, { config: cfg });

  // Show every eligible hook so users can opt in during setup.
  const eligibleHooks = report.hooks.filter((h) => h.loadable);

  if (eligibleHooks.length === 0) {
    await prompter.note(
      "No eligible hooks found. You can configure hooks later in your config.",
      "No Hooks Available",
    );
    return cfg;
  }

  const hookOptionValues = eligibleHooks.map((_, index) => `${HOOK_OPTION_PREFIX}${index}`);
  const hookNameByOptionValue = new Map(
    hookOptionValues.map((value, index) => [value, eligibleHooks[index]?.name ?? ""]),
  );

  const toEnable = await prompter.multiselect({
    message: "Enable hooks?",
    options: [
      { value: SKIP_SELECTION, label: "Skip for now" },
      {
        value: SELECT_ALL_SELECTION,
        label: "Select all",
        hint: "Enable every hook shown here",
      },
      ...eligibleHooks.map((hook, index) => ({
        value: hookOptionValues[index] ?? `${HOOK_OPTION_PREFIX}${index}`,
        label: `${hook.emoji ?? "🔗"} ${hook.name}`,
        hint: hook.description,
      })),
    ],
  });

  const selected = toEnable.includes(SELECT_ALL_SELECTION)
    ? eligibleHooks.map((hook) => hook.name)
    : toEnable
        .filter((value) => value !== SKIP_SELECTION)
        .map((value) => hookNameByOptionValue.get(value))
        .filter((name): name is string => Boolean(name));
  if (selected.length === 0) {
    return cfg;
  }

  // Enable selected hooks using the new entries config format
  const entries = { ...cfg.hooks?.internal?.entries };
  for (const name of selected) {
    entries[name] = { enabled: true };
  }

  const next: OpenClawConfig = {
    ...cfg,
    hooks: {
      ...cfg.hooks,
      internal: {
        enabled: true,
        entries,
      },
    },
  };

  await prompter.note(
    [
      `Enabled ${selected.length} hook${selected.length > 1 ? "s" : ""}: ${selected.join(", ")}`,
      "",
      "You can manage hooks later with:",
      `  ${formatCliCommand("openclaw hooks list")}`,
      `  ${formatCliCommand("openclaw hooks enable <name>")}`,
      `  ${formatCliCommand("openclaw hooks disable <name>")}`,
    ].join("\n"),
    "Hooks Configured",
  );

  return next;
}
