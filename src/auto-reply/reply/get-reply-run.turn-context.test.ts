import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareEmbeddedSessionState } from "../../agents/command/session-preparation.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { runEmbeddedFallbackCandidate } from "./agent-runner-embedded-candidate.js";
import { prepareReplyRunContext } from "./get-reply-run-context.js";
import { baseParams } from "./get-reply-run.test-support.js";
import { createSourceReplyDeliveryRuntime } from "./source-reply-delivery-runtime.js";

// mock-isolation: Capture the runtime handoff without executing providers or external effects.
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: vi.fn().mockResolvedValue({ payloads: [], meta: {} }),
}));

type Projection = {
  extraSystemPrompt?: string;
  extraSystemPromptTurnContext?: { start: number; text: string };
};

// Assert the generic exact-section contract without importing plugin-private code.
function persistentSuffix(run: Projection) {
  const section = run.extraSystemPromptTurnContext;
  expect(section).toBeDefined();
  expect(section!.start).toBe(0);
  expect(run.extraSystemPrompt?.slice(0, section!.text.length)).toBe(section!.text);
  const suffix = run.extraSystemPrompt!.slice(section!.text.length);
  expect(suffix === "" || suffix.startsWith("\n\n")).toBe(true);
  return suffix.replace(/^\n\n/, "");
}

function inbound(policy?: string, group = false, exec = false) {
  const ctx = {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    Provider: "whatsapp",
    Surface: "whatsapp",
    ChatType: group ? "group" : "direct",
    From: "+15550001111",
    To: "+15550002222",
    OriginatingChannel: "whatsapp" as const,
    OriginatingTo: "+15550001111",
    GroupSystemPrompt: policy,
  };
  return baseParams({
    ctx,
    sessionCtx: ctx,
    agentId: "main",
    sessionKey: "agent:main:main",
    execOverrides: exec ? { host: "gateway", security: "allowlist", ask: "on-miss" } : undefined,
  });
}

async function prepared(policy?: string, group = false, exec = false) {
  const context = await prepareReplyRunContext(inbound(policy, group, exec));
  if (context.kind !== "ready") {
    throw new Error("Expected real inbound context");
  }
  return context;
}

async function command() {
  const sessionEntry: SessionEntry = {
    sessionId: "synthetic-inbound",
    updatedAt: 1,
    chatType: "direct",
    delivery: normalizeSessionDeliveryState({
      context: { channel: "whatsapp", to: "+15550001111" },
      origin: { provider: "whatsapp", surface: "whatsapp", chatType: "direct", to: "+15550001111" },
    }),
  };
  // Independent private command: no owner spread, policy, sender authority or capabilities.
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-turn-context-"));
  const runId = `turn-context:${workspaceDir}`;
  try {
    const { opts } = await prepareEmbeddedSessionState({
      cfg: { agents: { defaults: { workspace: workspaceDir } } },
      sessionEntry,
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      sessionId: sessionEntry.sessionId,
      opts: {
        message: "Private completion",
        skipInitialSessionTouch: true,
        inputProvenance: { kind: "internal_system" },
        runContext: { messageChannel: "whatsapp", currentChannelId: "+15550001111" },
      },
      storePath: path.join(workspaceDir, "sessions.json"),
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
      runId,
      executionWorkspaceDir: workspaceDir,
      watchSkills: false,
      isNewSession: false,
      isSubagentLaneTurn: false,
      suppressVisibleSessionEffects: true,
      sessionStateActor: { actorType: "agent" },
    });
    return opts;
  } finally {
    clearAgentRunContext(runId);
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

function projection(context: Awaited<ReturnType<typeof prepared>>): Projection {
  return {
    extraSystemPrompt: context.extraSystemPromptParts.join("\n\n"),
    extraSystemPromptTurnContext: context.extraSystemPromptTurnContext,
  };
}

describe("inbound exact turn context", () => {
  it("transports real inbound context through the embedded candidate to runEmbeddedAgent", async () => {
    const context = await prepared("PERSISTENT POLICY");
    const run = {
      ...projection(context),
      config: {},
      sessionId: "synthetic-inbound",
      agentId: "main",
      sessionFile: "/synthetic/session.jsonl",
      workspaceDir: "/synthetic/workspace",
      provider: "anthropic",
      model: "claude-opus-4-1",
      timeoutMs: 1000,
    };
    await runEmbeddedFallbackCandidate({
      candidateRun: run,
      effectiveRun: run,
      candidateAgentRuntime: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
      provider: "anthropic",
      model: "claude-opus-4-1",
      runtimeConfig: {},
      runId: "synthetic-transport",
      currentTurnImages: {},
      turn: {
        followupRun: { run },
        sessionCtx: context.params.sessionCtx,
        sessionKey: "agent:main:main",
        commandBody: "hello",
        getActiveSessionEntry: () => undefined,
        typingSignals: { shouldStartOnReasoning: false },
      },
      timing: { logMilestoneIfSlow: () => {}, measure: (_name: string, fn: () => unknown) => fn() },
      getLifecycleGeneration: () => "synthetic-generation",
      onLifecycleBackstop: () => {},
      deferredLifecycle: {},
      presentation: {},
      bootstrapPromptWarningSignaturesSeen: [],
      onCompactionFacts: () => {},
    } as unknown as Parameters<typeof runEmbeddedFallbackCandidate>[0]);
    const captured = vi.mocked(runEmbeddedAgent).mock.calls.at(-1)![0];
    expect(captured.extraSystemPromptTurnContext).toEqual(context.extraSystemPromptTurnContext);
    expect(captured.extraSystemPromptTurnContext?.text).toContain("openclaw.inbound_meta.v2");
    expect(persistentSuffix(captured)).toBe("PERSISTENT POLICY");
  });

  it("matches an independent private command's empty persistent suffix without custom policy", async () => {
    const context = await prepared();
    const run = projection(context);
    expect(run.extraSystemPrompt).toContain("openclaw.inbound_meta.v2");
    expect(run.extraSystemPrompt).toContain(context.sourceConversationContextByMode.automatic);
    expect(persistentSuffix(run)).toBe("");
    const completion = await command();
    expect(completion.extraSystemPromptTurnContext?.text).toContain("openclaw.inbound_meta.v2");
    expect(persistentSuffix(completion)).toBe("");
  });

  it.each([false, true])(
    "keeps conversation policy, exec hint and caller suffix persistent (group=%s)",
    async (group) => {
      const context = await prepared("POLICY-A\nretain these bytes", group, true);
      const run = projection(context);
      run.extraSystemPrompt += "\n\nCALLER suffix\n  unchanged";
      const persistent = persistentSuffix(run);
      expect(persistent).toContain("POLICY-A\nretain these bytes");
      expect(persistent).toContain("gateway");
      expect(persistent.endsWith("CALLER suffix\n  unchanged")).toBe(true);
      const completion = await command();
      expect(persistentSuffix(completion)).not.toBe(persistent);
      const changed = projection(await prepared("POLICY-B", group, true));
      expect(persistentSuffix(changed)).not.toBe(persistent);
      const withoutExec = projection(await prepared("POLICY-A\nretain these bytes", group));
      expect(persistentSuffix(withoutExec)).not.toBe(persistentSuffix(projection(context)));
    },
  );

  it("rewrites only a valid contained annotation and leaves CLI binding and suffix bytes intact", async () => {
    const context = await prepared("POLICY", true, true);
    const run = projection(context);
    run.extraSystemPrompt += "\n\nCALLER";
    const suffix = persistentSuffix(run);
    const staticPrompt = context.extraSystemPromptStatic;
    const binding = JSON.stringify(context.cliSessionBindingFacts);
    const runtime = createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "automatic",
      projections: [run],
      promptComponentByMode: context.sourceConversationContextByMode,
      promptComponentOffset: context.sourceConversationContextPromptOffset,
    });
    const original = run.extraSystemPrompt;
    runtime.applyMode(run, "message_tool_only");
    expect(run.extraSystemPrompt).toBe(original);
    runtime.applyPreparedMode(run, "message_tool_only");
    expect(run.extraSystemPrompt).not.toBe(original);
    expect(persistentSuffix(run)).toBe(suffix);
    runtime.applyPreparedMode(run, "automatic");
    expect(run.extraSystemPrompt).toBe(original);
    expect(persistentSuffix(run)).toBe(suffix);
    expect(context.extraSystemPromptStatic).toBe(staticPrompt);
    expect(JSON.stringify(context.cliSessionBindingFacts)).toBe(binding);
  });

  it.each(["mismatch", "fractional", "outside", "bad-boundary", "future-match"])(
    "does not certify invalid or incompatible annotation: %s",
    (kind) => {
      const run: Projection = {
        extraSystemPrompt: "meta\n\nold\n\nPOLICY",
        extraSystemPromptTurnContext: {
          start: kind === "fractional" ? 0.5 : 0,
          text:
            kind === "mismatch"
              ? "wrong"
              : kind === "outside"
                ? "meta"
                : kind === "bad-boundary"
                  ? "meta\n\nol"
                  : kind === "future-match"
                    ? "meta\n\nnew"
                    : "meta\n\nold",
        },
      };
      const old = { ...run.extraSystemPromptTurnContext! };
      createSourceReplyDeliveryRuntime({
        origin: "runtime_default",
        initialMode: "automatic",
        projections: [run],
        promptComponentByMode: { automatic: "old", message_tool_only: "new" },
        promptComponentOffset: 6,
      }).applyPreparedMode(run, "message_tool_only");
      expect(run.extraSystemPrompt).toBe("meta\n\nnew\n\nPOLICY");
      // Invalid annotations must not become valid merely because the replacement matches them.
      expect(
        run.extraSystemPromptTurnContext === undefined ||
          run.extraSystemPrompt?.slice(old.start, old.start + old.text.length) !== old.text ||
          kind === "outside",
      ).toBe(true);
    },
  );
});
