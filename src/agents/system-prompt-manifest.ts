/**
 * The system prompt's section manifest. `buildAgentSystemPrompt` renders exactly these
 * sections, in this order; nothing else contributes core prompt text.
 *
 * - `region`: `stable` sections form the cached prefix shared across sessions (above
 *   `SYSTEM_PROMPT_CACHE_BOUNDARY`); `dynamic` sections are session facts below it, frozen
 *   per prompt series by the session prompt owner; `runtime` closes the prompt and may be
 *   relocated behind tools by providers.
 * - `includedWhen`: the capability or session fact that admits the section. Never a
 *   provider or model name.
 * - `budgetBytes`: the most UTF-8 bytes the section may render for the measured install shapes
 *   (system-prompt.inventory-snapshot.test.ts); content-bound sections carry their own caps.
 */
export type SystemPromptSectionRegion = "stable" | "dynamic" | "runtime";

export type SystemPromptSectionSpec = {
  readonly id: string;
  /** File that owns the section text. */
  readonly owner: string;
  readonly region: SystemPromptSectionRegion;
  readonly includedWhen: string;
  readonly budgetBytes: number;
};

export const SYSTEM_PROMPT_SECTIONS = [
  {
    id: "identity",
    owner: "system-prompt.ts",
    region: "stable",
    includedWhen: "always",
    budgetBytes: 64,
  },
  {
    id: "interaction_style",
    owner: "provider contribution (sectionOverrides.interaction_style)",
    region: "stable",
    includedWhen: "the provider contributes it",
    budgetBytes: 4_096,
  },
  {
    id: "execution_bias",
    owner: "system-prompt-policy-sections.ts",
    region: "stable",
    includedWhen: "full prompt, or a provider override",
    budgetBytes: 650,
  },
  {
    id: "promised_work",
    owner: "promised-work-prompt.ts",
    region: "stable",
    includedWhen: "always",
    budgetBytes: 620,
  },
  {
    id: "provider_stable_prefix",
    owner: "provider contribution (stablePrefix)",
    region: "stable",
    includedWhen: "the provider contributes it",
    budgetBytes: 8_192,
  },
  {
    id: "runtime_context",
    owner: "system-prompt-policy-sections.ts",
    region: "stable",
    includedWhen: "always",
    budgetBytes: 350,
  },
  {
    id: "workspace",
    owner: "system-prompt.ts",
    region: "stable",
    includedWhen: "always; directory roles when the working directory differs",
    budgetBytes: 2_048,
  },
  {
    id: "bootstrap",
    owner: "bootstrap-prompt.ts",
    region: "stable",
    includedWhen: "bootstrap pending or truncated bootstrap files",
    budgetBytes: 2_048,
  },
  {
    id: "workspace_files",
    owner: "system-prompt.ts",
    region: "stable",
    includedWhen: "always",
    budgetBytes: 128,
  },
  {
    id: "reasoning_format",
    owner: "system-prompt.ts",
    region: "stable",
    includedWhen: "the model needs reasoning tags",
    budgetBytes: 512,
  },
  {
    id: "project_context",
    owner: "system-prompt-context-files.ts",
    region: "stable",
    includedWhen: "workspace context files",
    budgetBytes: 160_000,
  },
  {
    id: "tooling",
    owner: "system-prompt-tool-list.ts",
    region: "dynamic",
    includedWhen: "tool guidance (tools present, or a full prompt)",
    budgetBytes: 24_576,
  },
  {
    id: "workspace_guidance",
    owner: "system-prompt.ts",
    region: "dynamic",
    includedWhen: "one working directory",
    budgetBytes: 320,
  },
  {
    id: "tool_workflow",
    owner: "system-prompt.ts, delegation-guidance.ts, system-prompt-policy-sections.ts",
    region: "dynamic",
    includedWhen:
      "exec/process, sessions, automations, screen, media tools; plugin command guidance",
    budgetBytes: 2_048,
  },
  {
    id: "tool_call_style",
    owner: "system-prompt-policy-sections.ts",
    region: "dynamic",
    includedWhen: "tool guidance, or a provider override",
    budgetBytes: 480,
  },
  {
    id: "care",
    owner: "system-prompt-policy-sections.ts",
    region: "dynamic",
    includedWhen: "always",
    budgetBytes: 1_000,
  },
  {
    id: "openclaw_control",
    owner: "system-prompt-control.ts",
    region: "dynamic",
    includedWhen: "openclaw, gateway, or exec tool",
    budgetBytes: 2_000,
  },
  {
    id: "skills",
    owner: "system-prompt-skills.ts",
    region: "dynamic",
    includedWhen: "skills and a way to read them",
    budgetBytes: 24_576,
  },
  {
    id: "tool_guidance",
    owner: "plugin tool promptGuidance (tool-prompt-guidance.ts)",
    region: "dynamic",
    includedWhen: "the plugin's tool is callable",
    budgetBytes: 8_192,
  },
  {
    id: "session_project",
    owner: "session-project-guidance.ts",
    region: "dynamic",
    includedWhen: "session_project tool",
    budgetBytes: 2_048,
  },
  {
    id: "memory",
    owner: "memory plugin prompt (plugins/memory-state.ts)",
    region: "dynamic",
    includedWhen: "full prompt with memory tools",
    budgetBytes: 2_048,
  },
  {
    id: "model_aliases",
    owner: "system-prompt.ts",
    region: "dynamic",
    includedWhen: "configured model aliases",
    budgetBytes: 4_096,
  },
  {
    id: "documentation",
    owner: "system-prompt-documentation.ts",
    region: "dynamic",
    includedWhen: "full prompt",
    budgetBytes: 1_024,
  },
  {
    id: "sandbox",
    owner: "system-prompt.ts",
    region: "dynamic",
    includedWhen: "sandboxed runtime",
    budgetBytes: 2_048,
  },
  {
    id: "project_memory",
    owner: "project-memory-bootstrap.ts",
    region: "dynamic",
    includedWhen: "repository memory facts",
    budgetBytes: 8_192,
  },
  {
    id: "delegation",
    owner: "delegation-guidance.ts, ultra-orchestration.ts",
    region: "dynamic",
    includedWhen: "sessions_spawn (ACP threads when the channel binds them)",
    budgetBytes: 4_096,
  },
  {
    id: "elevated_level",
    owner: "system-prompt.ts",
    region: "dynamic",
    includedWhen: "sandboxed runtime with elevated exec facts",
    budgetBytes: 160,
  },
  {
    id: "output_directives",
    owner: "system-prompt-messaging.ts",
    region: "dynamic",
    includedWhen: "full prompt with a visible reply path",
    budgetBytes: 512,
  },
  {
    id: "silent_replies",
    owner: "system-prompt.ts",
    region: "dynamic",
    includedWhen: "full prompt on a channel that allows silence",
    budgetBytes: 420,
  },
  {
    id: "exec_approval",
    owner: "system-prompt-control.ts",
    region: "dynamic",
    includedWhen: "exec tool without a provider tool_call_style override",
    budgetBytes: 400,
  },
  {
    id: "authorized_senders",
    owner: "system-prompt.ts",
    region: "dynamic",
    includedWhen: "full prompt with owner numbers",
    budgetBytes: 1_100,
  },
  {
    id: "ui_presentation",
    owner: "ui-presentation-prompt.ts",
    region: "dynamic",
    includedWhen: "full prompt with UI tools",
    budgetBytes: 1_450,
  },
  {
    id: "control_ui",
    owner: "system-prompt.ts",
    region: "dynamic",
    includedWhen: "full prompt on the webchat channel",
    budgetBytes: 1_536,
  },
  {
    id: "messaging",
    owner: "system-prompt-messaging.ts",
    region: "dynamic",
    includedWhen: "full prompt; message tool details when listed",
    budgetBytes: 1_600,
  },
  {
    id: "collapsible_details",
    owner: "system-prompt.ts",
    region: "dynamic",
    includedWhen: "full prompt on a channel with markdownDetails",
    budgetBytes: 240,
  },
  {
    id: "voice",
    owner: "tts preferences",
    region: "dynamic",
    includedWhen: "full prompt with a TTS hint",
    budgetBytes: 1_024,
  },
  {
    id: "conversation_context",
    owner: "callers' extraSystemPrompt (session/turn instructions)",
    region: "dynamic",
    includedWhen: "the caller supplies session instructions",
    budgetBytes: 65_536,
  },
  {
    id: "reactions",
    owner: "system-prompt.ts",
    region: "dynamic",
    includedWhen: "channel reaction guidance",
    budgetBytes: 240,
  },
  {
    id: "provider_dynamic_suffix",
    owner: "provider contribution (dynamicSuffix)",
    region: "dynamic",
    includedWhen: "the provider contributes it",
    budgetBytes: 8_192,
  },
  {
    id: "watched_sessions",
    owner: "watched-sessions-prompt.ts",
    region: "dynamic",
    includedWhen: "watched group sessions",
    budgetBytes: 4_096,
  },
  {
    id: "runtime",
    owner: "system-prompt.ts, system-prompt-runtime.ts",
    region: "runtime",
    includedWhen: "always",
    budgetBytes: 1_024,
  },
] as const satisfies readonly SystemPromptSectionSpec[];

export type SystemPromptSectionId = (typeof SYSTEM_PROMPT_SECTIONS)[number]["id"];

/** @internal Budget gate for the fresh-install fixture (12,864 B after the shave; ~5% headroom). */
export const FRESH_INSTALL_SYSTEM_PROMPT_BUDGET_BYTES = 13_500;
