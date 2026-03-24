import "./reply.directive.directive-behavior.e2e-mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, resolveSessionKey, saveSessionStore } from "../config/sessions.js";
import {
  DEFAULT_TEST_MODEL_CATALOG,
  installDirectiveBehaviorE2EHooks,
  makeEmbeddedTextResult,
  makeWhatsAppDirectiveConfig,
  replyText,
  replyTexts,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import {
  loadModelCatalogMock,
  runEmbeddedPiAgentMock,
} from "./reply.directive.directive-behavior.e2e-mocks.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
let actualRunPreparedReply: typeof import("./reply/get-reply-run.js").runPreparedReply;
const runPreparedReplyMock = vi.hoisted(() => vi.fn());

function installFreshDirectiveBehaviorReplyMocks() {
  vi.doMock("../agents/pi-embedded.js", () => ({
    abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
    isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  }));
  vi.doMock("../agents/model-catalog.js", () => ({
    loadModelCatalog: loadModelCatalogMock,
  }));
  vi.doMock("./reply/get-reply-run.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./reply/get-reply-run.js")>();
    actualRunPreparedReply = actual.runPreparedReply;
    return {
      ...actual,
      runPreparedReply: (...args: Parameters<typeof actual.runPreparedReply>) =>
        runPreparedReplyMock(...args),
    };
  });
}

async function writeSkill(params: { workspaceDir: string; name: string; description: string }) {
  const { workspaceDir, name, description } = params;
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf-8",
  );
}

async function runThinkingDirective(home: string, model: string) {
  const res = await getReplyFromConfig(
    {
      Body: "/thinking xhigh",
      From: "+1004",
      To: "+2000",
      CommandAuthorized: true,
    },
    {},
    makeWhatsAppDirectiveConfig(home, { model }, { session: { store: sessionStorePath(home) } }),
  );
  return replyTexts(res);
}

async function runThinkDirectiveAndGetText(home: string): Promise<string | undefined> {
  const res = await getReplyFromConfig(
    { Body: "/think", From: "+1222", To: "+1222", CommandAuthorized: true },
    {},
    makeWhatsAppDirectiveConfig(home, {
      model: "anthropic/claude-opus-4-5",
      thinkingDefault: "high",
    }),
  );
  return replyText(res);
}

async function runInlineReasoningMessage(params: {
  home: string;
  body: string;
  storePath: string;
  blockReplies: string[];
}) {
  return await getReplyFromConfig(
    {
      Body: params.body,
      From: "+1222",
      To: "+1222",
      Provider: "whatsapp",
    },
    {
      onBlockReply: (payload) => {
        if (payload.text) {
          params.blockReplies.push(payload.text);
        }
      },
    },
    makeWhatsAppDirectiveConfig(
      params.home,
      { model: "anthropic/claude-opus-4-5" },
      {
        session: { store: params.storePath },
      },
    ),
  );
}

function makeRunConfig(home: string, storePath: string) {
  return makeWhatsAppDirectiveConfig(
    home,
    { model: "anthropic/claude-opus-4-5" },
    { session: { store: storePath } },
  );
}

async function runInFlightVerboseToggleCase(params: {
  home: string;
  shouldEmitBefore: boolean;
  toggledVerboseLevel: "on" | "off";
  seedVerboseOn?: boolean;
}) {
  const storePath = sessionStorePath(params.home);
  const ctx = {
    Body: "please do the thing",
    From: "+1004",
    To: "+2000",
  };
  const sessionKey = resolveSessionKey(
    "per-sender",
    { From: ctx.From, To: ctx.To, Body: ctx.Body },
    "main",
  );

  runEmbeddedPiAgentMock.mockImplementation(async (agentParams) => {
    const shouldEmit = agentParams.shouldEmitToolResult;
    expect(shouldEmit?.()).toBe(params.shouldEmitBefore);
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey] ?? {
      sessionId: "s",
      updatedAt: Date.now(),
    };
    store[sessionKey] = {
      ...entry,
      verboseLevel: params.toggledVerboseLevel,
      updatedAt: Date.now(),
    };
    await saveSessionStore(storePath, store);
    expect(shouldEmit?.()).toBe(!params.shouldEmitBefore);
    return makeEmbeddedTextResult("done");
  });

  if (params.seedVerboseOn) {
    await getReplyFromConfig(
      { Body: "/verbose on", From: ctx.From, To: ctx.To, CommandAuthorized: true },
      {},
      makeRunConfig(params.home, storePath),
    );
  }

  const res = await getReplyFromConfig(ctx, {}, makeRunConfig(params.home, storePath));
  return { res };
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  beforeEach(async () => {
    vi.resetModules();
    loadModelCatalogMock.mockReset();
    loadModelCatalogMock.mockResolvedValue(DEFAULT_TEST_MODEL_CATALOG);
    installFreshDirectiveBehaviorReplyMocks();
    ({ getReplyFromConfig } = await import("./reply.js"));
    runPreparedReplyMock.mockReset();
    runPreparedReplyMock.mockImplementation((...args: Parameters<typeof actualRunPreparedReply>) =>
      actualRunPreparedReply(...args),
    );
  });

  it("keeps reasoning acks out of mixed messages, including rapid repeats", async () => {
    await withTempHome(async (home) => {
      runPreparedReplyMock.mockResolvedValue({ text: "done" });

      const blockReplies: string[] = [];
      const storePath = sessionStorePath(home);

      const firstRes = await runInlineReasoningMessage({
        home,
        body: "please reply\n/reasoning on",
        storePath,
        blockReplies,
      });
      expect(replyTexts(firstRes)).toContain("done");

      await runInlineReasoningMessage({
        home,
        body: "again\n/reasoning on",
        storePath,
        blockReplies,
      });

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(2);
      expect(blockReplies.length).toBe(0);
    });
  });
  it("handles standalone verbose directives and persistence", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);

      const enabledRes = await getReplyFromConfig(
        { Body: "/verbose on", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        makeWhatsAppDirectiveConfig(home, { model: "anthropic/claude-opus-4-5" }),
      );
      expect(replyText(enabledRes)).toMatch(/^⚙️ Verbose logging enabled\./);

      const disabledRes = await getReplyFromConfig(
        { Body: "/verbose off", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          { model: "anthropic/claude-opus-4-5" },
          {
            session: { store: storePath },
          },
        ),
      );

      const text = replyText(disabledRes);
      expect(text).toMatch(/Verbose logging disabled\./);
      const store = loadSessionStore(storePath);
      const entry = Object.values(store)[0];
      expect(entry?.verboseLevel).toBe("off");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("updates tool verbose during in-flight runs for toggle on/off", async () => {
    await withTempHome(async (home) => {
      for (const testCase of [
        {
          shouldEmitBefore: false,
          toggledVerboseLevel: "on" as const,
        },
        {
          shouldEmitBefore: true,
          toggledVerboseLevel: "off" as const,
          seedVerboseOn: true,
        },
      ]) {
        runEmbeddedPiAgentMock.mockClear();
        const { res } = await runInFlightVerboseToggleCase({
          home,
          ...testCase,
        });
        const texts = replyTexts(res);
        expect(texts).toContain("done");
        expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
      }
    });
  });
  it("covers think status and /thinking xhigh support matrix", async () => {
    await withTempHome(async (home) => {
      const text = await runThinkDirectiveAndGetText(home);
      expect(text).toContain("Current thinking level: high");
      expect(text).toContain("Options: off, minimal, low, medium, high, adaptive.");

      for (const model of [
        "openai-codex/gpt-5.2-codex",
        "openai/gpt-5.2",
        "openai/gpt-5.4-mini",
        "openai/gpt-5.4-nano",
      ]) {
        const texts = await runThinkingDirective(home, model);
        expect(texts).toContain("Thinking level set to xhigh.");
      }

      const unsupportedModelTexts = await runThinkingDirective(home, "openai/gpt-4.1-mini");
      expect(unsupportedModelTexts[0]).toContain('Thinking level "xhigh" is only supported for');
      expect(unsupportedModelTexts[0]).toContain("provider models that advertise xhigh reasoning");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("keeps reserved command aliases from matching after trimming", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/help",
          From: "+1222",
          To: "+1222",
          CommandAuthorized: true,
        },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          {
            model: "anthropic/claude-opus-4-5",
            models: {
              "anthropic/claude-opus-4-5": { alias: " help " },
            },
          },
          { session: { store: sessionStorePath(home) } },
        ),
      );

      const text = replyText(res);
      expect(text).toContain("Help");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("treats skill commands as reserved for model aliases", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "openclaw");
      await writeSkill({
        workspaceDir: workspace,
        name: "demo-skill",
        description: "Demo skill",
      });

      await getReplyFromConfig(
        {
          Body: "/demo_skill",
          From: "+1222",
          To: "+1222",
          CommandAuthorized: true,
        },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          {
            model: "anthropic/claude-opus-4-5",
            workspace,
            models: {
              "anthropic/claude-opus-4-5": { alias: "demo_skill" },
            },
          },
          { session: { store: sessionStorePath(home) } },
        ),
      );

      expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
      const prompt = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain('Use the "demo-skill" skill');
    });
  });
  it("reports invalid queue options and current queue settings", async () => {
    await withTempHome(async (home) => {
      const invalidRes = await getReplyFromConfig(
        {
          Body: "/queue collect debounce:bogus cap:zero drop:maybe",
          From: "+1222",
          To: "+1222",
          CommandAuthorized: true,
        },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          { model: "anthropic/claude-opus-4-5" },
          {
            session: { store: sessionStorePath(home) },
          },
        ),
      );

      const invalidText = replyText(invalidRes);
      expect(invalidText).toContain("Invalid debounce");
      expect(invalidText).toContain("Invalid cap");
      expect(invalidText).toContain("Invalid drop policy");

      const currentRes = await getReplyFromConfig(
        {
          Body: "/queue",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          CommandAuthorized: true,
        },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          { model: "anthropic/claude-opus-4-5" },
          {
            messages: {
              queue: {
                mode: "collect",
                debounceMs: 1500,
                cap: 9,
                drop: "summarize",
              },
            },
            session: { store: sessionStorePath(home) },
          },
        ),
      );

      const text = replyText(currentRes);
      expect(text).toContain(
        "Current queue settings: mode=collect, debounce=1500ms, cap=9, drop=summarize.",
      );
      expect(text).toContain(
        "Options: modes steer, followup, collect, steer+backlog, interrupt; debounce:<ms|s|m>, cap:<n>, drop:old|new|summarize.",
      );
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
});
