import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

type EmbeddedRunParams = {
  prompt?: string;
  extraSystemPrompt?: string;
  onAgentEvent?: (evt: { stream?: string; data?: { phase?: string; willRetry?: boolean } }) => void;
};

const state = vi.hoisted(() => ({
  runEmbeddedPiAgentMock: vi.fn(),
  runCliAgentMock: vi.fn(),
}));

export function getRunEmbeddedPiAgentMock() {
  return state.runEmbeddedPiAgentMock;
}

export function getRunCliAgentMock() {
  return state.runCliAgentMock;
}

export type { EmbeddedRunParams };

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
  }),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (params: unknown) => state.runCliAgentMock(params),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

export async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  entry: Record<string, unknown>;
}) {
  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await fs.writeFile(
    params.storePath,
    JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
    "utf-8",
  );
}

export function createBaseRun(params: {
  storePath: string;
  sessionEntry: Record<string, unknown>;
  config?: Record<string, unknown>;
  runOverrides?: Partial<FollowupRun["run"]>;
}) {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "whatsapp",
    OriginatingTo: "+15550001111",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: params.config ?? {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;
  const run = {
    ...followupRun.run,
    ...params.runOverrides,
    config: params.config ?? followupRun.run.config,
  };

  return {
    typing,
    sessionCtx,
    resolvedQueue,
    followupRun: { ...followupRun, run },
  };
}
