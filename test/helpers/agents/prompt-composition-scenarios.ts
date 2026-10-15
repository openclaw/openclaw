// Prompt composition scenarios build reusable agent prompt fixtures.
import fs from "node:fs/promises";
import { buildBootstrapPromptWarning } from "../../../src/agents/bootstrap-budget-warning.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarningNotice,
} from "../../../src/agents/bootstrap-budget.js";
import { resolveBootstrapContextForRun } from "../../../src/agents/bootstrap-files.js";
import { buildCurrentInboundPrompt } from "../../../src/agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { buildAgentSystemPrompt } from "../../../src/agents/system-prompt.js";
import { buildGroupChatContext } from "../../../src/auto-reply/reply/groups.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
} from "../../../src/auto-reply/reply/inbound-meta.js";
import { buildReplyPromptEnvelope } from "../../../src/auto-reply/reply/prompt-prelude.js";
import type { TemplateContext } from "../../../src/auto-reply/templating.js";
import { SILENT_REPLY_TOKEN } from "../../../src/auto-reply/tokens.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../src/test-helpers/workspace.js";

/** One turn in a prompt composition scenario. */
type PromptScenarioTurn = {
  id: string;
  systemPrompt: string;
  bodyPrompt: string;
};

/** Multi-turn prompt composition scenario fixture. */
export type PromptScenario = {
  scenario: string;
  turns: PromptScenarioTurn[];
};

function buildCommonSystemParams(workspaceDir: string) {
  const toolNames = [
    "bash",
    "read",
    "edit",
    "grep",
    "glob",
    "message",
    "memory_search",
    "memory_get",
    "web_search",
    "x_search",
    "web_fetch",
  ];
  return {
    runtimeInfo: {
      agentId: "main",
      host: "cache-lab",
      repoRoot: workspaceDir,
      os: "Darwin 24.0.0",
      arch: "arm64",
      node: process.version,
      model: "anthropic/claude-sonnet-4-6",
      defaultModel: "anthropic/claude-sonnet-4-6",
      shell: "zsh",
    },
    toolNames,
  };
}

function buildSystemPrompt(params: {
  workspaceDir: string;
  extraSystemPrompt?: string;
  contextFiles?: Array<{ path: string; content: string }>;
  bootstrapTruncationNotice?: string;
  silentReplyPromptMode?: "generic" | "none";
}) {
  const { runtimeInfo, toolNames } = buildCommonSystemParams(params.workspaceDir);
  return buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    extraSystemPrompt: params.extraSystemPrompt,
    runtimeInfo,
    toolNames,
    modelAliasLines: [],
    promptMode: "full",
    silentReplyPromptMode: params.silentReplyPromptMode,
    acpEnabled: true,
    contextFiles: params.contextFiles,
    bootstrapTruncationNotice: params.bootstrapTruncationNotice,
  });
}

function buildAutoReplyModelPrompt(params: { ctx: TemplateContext; body: string }): string {
  const inboundUserContext = buildInboundUserContextPrefix(params.ctx);
  const envelope = buildReplyPromptEnvelope({
    ctx: params.ctx,
    sessionCtx: params.ctx,
    baseBody: params.body,
    hasUserBody: true,
    inboundUserContext,
    isBareSessionReset: false,
    startupAction: "new",
  });
  return buildCurrentInboundPrompt({
    context: envelope.currentInboundContext,
    prompt: envelope.queuedBody,
  });
}

function buildAutoReplySystemPrompt(params: { workspaceDir: string; sessionCtx: TemplateContext }) {
  const extraSystemPromptParts = [
    buildInboundMetaSystemPrompt(params.sessionCtx, {}),
    buildGroupChatContext({
      sessionCtx: params.sessionCtx,
      silentToken: SILENT_REPLY_TOKEN,
      silentReplyPolicy: "allow",
    }),
  ].filter(Boolean);
  return buildSystemPrompt({
    workspaceDir: params.workspaceDir,
    extraSystemPrompt: extraSystemPromptParts.join("\n\n") || undefined,
    silentReplyPromptMode: "none",
  });
}

function createDiscordBoundaryScenario(workspaceDir: string): PromptScenario {
  const body = "Please summarize the deploy log.";
  const baseCtx: TemplateContext = {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:987654321",
    AccountId: "A1",
    ChatType: "channel",
    GroupSubject: "#ops-bridge",
    GroupChannel: "#ops-bridge",
    GroupSpace: "guild-123",
    SenderId: "U3",
    SenderName: "Cael",
    MessageSid: "1503084621145964846",
    Body: body,
    BodyStripped: body,
    ChannelStructuredContext: [
      {
        label: "Discord channel metadata",
        source: "discord",
        type: "channel_metadata",
        payload: {
          topic: "Deploy coordination",
        },
      },
    ],
  };
  return {
    scenario: "auto-reply-discord-boundary",
    turns: [
      {
        id: "t1",
        systemPrompt: buildAutoReplySystemPrompt({
          workspaceDir,
          sessionCtx: baseCtx,
        }),
        bodyPrompt: buildAutoReplyModelPrompt({
          ctx: baseCtx,
          body,
        }),
      },
    ],
  };
}

async function createBootstrapWarningScenario(workspaceDir: string): Promise<PromptScenario> {
  const bootstrapConfig = {
    agents: {
      defaults: {
        bootstrapMaxChars: 1_500,
        bootstrapTotalMaxChars: 2_200,
      },
      entries: { main: {} },
    },
  } satisfies OpenClawConfig;
  const largeAgents = "# AGENTS.md\n\n" + "Rules.\n".repeat(5_000);
  const largeSoul = "# SOUL.md\n\n" + "Notes.\n".repeat(3_000);
  await writeWorkspaceFile({ dir: workspaceDir, name: "AGENTS.md", content: largeAgents });
  await writeWorkspaceFile({ dir: workspaceDir, name: "SOUL.md", content: largeSoul });
  const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: bootstrapConfig,
  });
  const analysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars: bootstrapConfig.agents.defaults.bootstrapMaxChars,
    bootstrapTotalMaxChars: bootstrapConfig.agents.defaults.bootstrapTotalMaxChars,
  });
  if (!analysis.hasTruncation) {
    throw new Error("bootstrap-warning scenario expected truncated bootstrap context");
  }
  const warning = buildBootstrapPromptWarning({
    analysis,
    mode: "always",
    seenSignatures: [],
  });
  const truncationNotice = buildBootstrapPromptWarningNotice(warning.lines);
  if (!truncationNotice) {
    throw new Error("bootstrap-warning scenario expected a truncation notice");
  }
  return {
    scenario: "bootstrap-warning",
    turns: [
      {
        id: "t1",
        systemPrompt: buildSystemPrompt({
          workspaceDir,
          contextFiles,
          bootstrapTruncationNotice: truncationNotice,
        }),
        bodyPrompt: "hello",
      },
      {
        id: "t2",
        systemPrompt: buildSystemPrompt({
          workspaceDir,
          contextFiles,
          bootstrapTruncationNotice: truncationNotice,
        }),
        bodyPrompt: "hello again",
      },
      {
        id: "t3",
        systemPrompt: buildSystemPrompt({
          workspaceDir,
          contextFiles,
          bootstrapTruncationNotice: truncationNotice,
        }),
        bodyPrompt: "one more turn",
      },
    ],
  };
}

/** Create a temp workspace with prompt composition context files. */
async function createWorkspaceWithPromptCompositionFiles(): Promise<string> {
  const workspaceDir = await makeTempWorkspace("openclaw-prompt-cache-");
  await writeWorkspaceFile({
    dir: workspaceDir,
    name: "AGENTS.md",
    content: [
      "# AGENTS.md",
      "",
      "## Session Startup",
      "Read AGENTS.md before making changes.",
      "",
      "## Tools",
      "Use rg before grep.",
      "",
      "## Red Lines",
      "Do not rewrite user commits.",
    ].join("\n"),
  });
  await writeWorkspaceFile({
    dir: workspaceDir,
    name: "SOUL.md",
    content: "# SOUL.md\n\nBe concise but kind.\n",
  });
  return workspaceDir;
}

/** Create all prompt composition scenarios plus cleanup handles. */
export async function createPromptCompositionScenarios(): Promise<{
  scenarios: PromptScenario[];
  cleanup: () => Promise<void>;
}> {
  const workspaceDir = await createWorkspaceWithPromptCompositionFiles();
  const warningWorkspaceDir = await makeTempWorkspace("openclaw-prompt-cache-warning-");
  const scenarios = [
    createDiscordBoundaryScenario(workspaceDir),
    await createBootstrapWarningScenario(warningWorkspaceDir),
  ];
  return {
    scenarios,
    cleanup: async () => {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(warningWorkspaceDir, { recursive: true, force: true });
    },
  };
}
