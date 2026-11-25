// Prompt composition scenarios build reusable agent prompt fixtures.
import fs from "node:fs/promises";
import {
  buildBootstrapBudgetState,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarningNotice,
} from "../../../src/agents/bootstrap-budget.js";
import { resolveBootstrapContextForRun } from "../../../src/agents/bootstrap-files.js";
import { buildCurrentInboundPrompt } from "../../../src/agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { buildAgentSystemPrompt } from "../../../src/agents/system-prompt.js";
import { buildSourceConversationContext } from "../../../src/auto-reply/reply/groups.js";
import { buildInboundMetaSystemPrompt } from "../../../src/auto-reply/reply/inbound-meta.js";
import type { TemplateContext } from "../../../src/auto-reply/templating.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../src/test-helpers/workspace.js";
import { preparePromptSnapshotReply } from "./prepared-reply-prompt.js";

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

async function buildAutoReplyModelPrompt(params: {
  ctx: TemplateContext;
  body: string;
  workspaceDir: string;
}): Promise<string> {
  const prepared = await preparePromptSnapshotReply(params);
  const envelope = prepared.buildPromptBodies({});
  return buildCurrentInboundPrompt({
    context: envelope.currentInboundContext,
    prompt: envelope.queuedBody,
  });
}

function buildAutoReplySystemPrompt(params: { workspaceDir: string; sessionCtx: TemplateContext }) {
  const extraSystemPromptParts = [
    buildInboundMetaSystemPrompt(params.sessionCtx, {}),
    buildSourceConversationContext({
      sessionCtx: params.sessionCtx,
    }),
  ].filter(Boolean);
  return buildSystemPrompt({
    workspaceDir: params.workspaceDir,
    extraSystemPrompt: extraSystemPromptParts.join("\n\n") || undefined,
    silentReplyPromptMode: "none",
  });
}

async function createDiscordBoundaryScenario(
  workspaceDir: string,
): Promise<{ systemPrompt: string; bodyPrompt: string }> {
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
    systemPrompt: buildAutoReplySystemPrompt({
      workspaceDir,
      sessionCtx: baseCtx,
    }),
    bodyPrompt: await buildAutoReplyModelPrompt({
      ctx: baseCtx,
      body,
      workspaceDir,
    }),
  };
}

async function createBootstrapWarningScenario(workspaceDir: string): Promise<string> {
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
  const { bootstrapAnalysis: analysis, bootstrapPromptWarning: warning } =
    buildBootstrapBudgetState({
      config: bootstrapConfig,
      files: buildBootstrapInjectionStats({
        bootstrapFiles,
        injectedFiles: contextFiles,
      }),
    });
  if (!analysis.hasTruncation) {
    throw new Error("bootstrap-warning scenario expected truncated bootstrap context");
  }
  const truncationNotice = buildBootstrapPromptWarningNotice(warning.lines);
  if (!truncationNotice) {
    throw new Error("bootstrap-warning scenario expected a truncation notice");
  }
  return buildSystemPrompt({
    workspaceDir,
    contextFiles,
    bootstrapTruncationNotice: truncationNotice,
  });
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
export async function createPromptCompositionScenarios() {
  const workspaceDir = await createWorkspaceWithPromptCompositionFiles();
  const warningWorkspaceDir = await makeTempWorkspace("openclaw-prompt-cache-warning-");
  return {
    discordBoundary: await createDiscordBoundaryScenario(workspaceDir),
    bootstrapWarningSystemPrompt: await createBootstrapWarningScenario(warningWorkspaceDir),
    cleanup: async () => {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(warningWorkspaceDir, { recursive: true, force: true });
    },
  };
}
