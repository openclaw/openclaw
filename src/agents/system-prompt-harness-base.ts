/**
 * Thread-stable base prompt for harnesses that pin base instructions at thread creation.
 *
 * Reuses the regular prompt's policy sections and omits every turn, channel,
 * workspace, and catalog fact: those keep their own harness carriers, so a
 * routine turn cannot change the pinned bytes and invalidate the native thread.
 */
import { isRestartEnabled } from "../config/commands.flags.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPromisedWorkPromptSection } from "./promised-work-prompt.js";
import type { ProviderSystemPromptContribution } from "./system-prompt-contribution.js";
import { buildOpenClawControlSection } from "./system-prompt-control.js";
import { buildDocumentationSection } from "./system-prompt-documentation.js";
import {
  buildCareSection,
  buildExecutionBiasSection,
  buildMediaGenerationToolLines,
  buildRuntimeContextSection,
  buildToolCallStyleSection,
  normalizeProviderPromptBlock,
} from "./system-prompt-policy-sections.js";
import type { PromptMode } from "./system-prompt.types.js";
import { listToolPromptGuidance } from "./tool-prompt-guidance.js";

const HARNESS_IDENTITY = "You are a personal assistant running inside OpenClaw.";

export function buildAgentHarnessBasePrompt(params: {
  config?: OpenClawConfig;
  /** Unqualified callable tool names; deferred tools count because they stay callable. */
  toolNames: Iterable<string>;
  promptMode?: PromptMode;
  /** Only the thread-stable parts apply: the provider's dynamic suffix is not rendered. */
  promptContribution?: ProviderSystemPromptContribution;
  nativeCommandGuidanceLines?: readonly string[];
}): string {
  const promptMode = params.promptMode ?? "full";
  if (promptMode === "none") {
    return HARNESS_IDENTITY;
  }
  const isMinimal = promptMode === "minimal";
  const availableTools = new Set([...params.toolNames].map((name) => name.trim().toLowerCase()));
  const overrides = params.promptContribution?.sectionOverrides;
  const toolGuidance = listToolPromptGuidance(availableTools);
  const sections: (readonly (string | undefined | false)[])[] = [
    [HARNESS_IDENTITY, ""],
    [normalizeProviderPromptBlock(overrides?.interaction_style)],
    normalizeProviderPromptBlock(overrides?.execution_bias)
      ? [normalizeProviderPromptBlock(overrides?.execution_bias)]
      : isMinimal
        ? []
        : buildExecutionBiasSection(),
    buildPromisedWorkPromptSection(),
    [normalizeProviderPromptBlock(params.promptContribution?.stablePrefix)],
    buildRuntimeContextSection(),
    [""],
    params.nativeCommandGuidanceLines ?? [],
    availableTools.has("process")
      ? [
          "Before input: process log; log/poll shows waitingForInput/stdinWritable. Lost id: process list.",
        ]
      : [],
    availableTools.has("sessions_spawn")
      ? [
          "Follow each spawn's accepted completion mode: collectors need explicit result collection, not completion events.",
          "Treat subagent outputs as reports to synthesize.",
        ]
      : [],
    buildMediaGenerationToolLines(availableTools),
    [""],
    normalizeProviderPromptBlock(overrides?.tool_call_style)
      ? [normalizeProviderPromptBlock(overrides?.tool_call_style)]
      : !isMinimal || availableTools.size > 0
        ? buildToolCallStyleSection()
        : [],
    buildCareSection({
      controlToolsAvailable: availableTools.has("openclaw") || availableTools.has("gateway"),
    }),
    buildOpenClawControlSection({
      hasOpenClaw: availableTools.has("openclaw"),
      hasGateway: availableTools.has("gateway"),
      hasExec: availableTools.has("exec"),
      restartCommandsEnabled: params.config ? isRestartEnabled(params.config) : true,
    }),
    toolGuidance.flatMap((section) => [section, ""]),
    // Local docs paths need async resolution and differ per install, so a pinned prompt
    // names the public mirror.
    isMinimal ? [] : buildDocumentationSection({ availableTools, sandboxed: false }),
  ];
  return sections
    .flat()
    .filter((line): line is string => line !== undefined && line !== false)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
