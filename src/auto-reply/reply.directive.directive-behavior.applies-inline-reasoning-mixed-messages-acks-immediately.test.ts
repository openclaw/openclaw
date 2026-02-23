import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore, resolveSessionKey, saveSessionStore } from "../config/sessions.js";
import {
  installDirectiveBehaviorE2EHooks,
  makeEmbeddedTextResult,
  makeWhatsAppDirectiveConfig,
  replyText,
  replyTexts,
  runEmbeddedPiAgent,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

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

function mockEmbeddedResponse(text: string) {
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue(makeEmbeddedTextResult(text));
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

  vi.mocked(runEmbeddedPiAgent).mockImplementation(async (agentParams) => {
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

  it("applies inline reasoning in mixed messages and acks immediately", async () => {
    await withTempHome(async (home) => {
      mockEmbeddedResponse("done");

      const blockReplies: string[] = [];
      const storePath = sessionStorePath(home);

      const res = await runInlineReasoningMessage({
        home,
        body: "please reply\n/reasoning on",
        storePath,
        blockReplies,
      });

      const texts = replyTexts(res);
      expect(texts).toContain("done");

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });
  it("keeps reasoning acks for rapid mixed directives", async () => {
    await withTempHome(async (home) => {
      mockEmbeddedResponse("ok");

      const blockReplies: string[] = [];
      const storePath = sessionStorePath(home);

      await runInlineReasoningMessage({
        home,
        body: "do it\n/reasoning on",
        storePath,
        blockReplies,
      });

      await runInlineReasoningMessage({
        home,
        body: "again\n/reasoning on",
        storePath,
        blockReplies,
      });

      expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(2);
      expect(blockReplies.length).toBe(0);
    });
  });
  it("acks verbose directive immediately with system marker", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        { Body: "/verbose on", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        makeWhatsAppDirectiveConfig(home, { model: "anthropic/claude-opus-4-5" }),
      );

      const text = replyText(res);
      expect(text).toMatch(/^⚙️ Verbose logging enabled\./);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("persists verbose off when directive is standalone", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);

      const res = await getReplyFromConfig(
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

      const text = replyText(res);
      expect(text).toMatch(/Verbose logging disabled\./);
      const store = loadSessionStore(storePath);
      const entry = Object.values(store)[0];
      expect(entry?.verboseLevel).toBe("off");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("updates tool verbose during an in-flight run (toggle on)", async () => {
    await withTempHome(async (home) => {
      const { res } = await runInFlightVerboseToggleCase({
        home,
        shouldEmitBefore: false,
        toggledVerboseLevel: "on",
      });

      const texts = replyTexts(res);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });
  it("updates tool verbose during an in-flight run (toggle off)", async () => {
    await withTempHome(async (home) => {
      const { res } = await runInFlightVerboseToggleCase({
        home,
        shouldEmitBefore: true,
        toggledVerboseLevel: "off",
        seedVerboseOn: true,
      });

      const texts = replyTexts(res);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });
  it("shows current think level when /think has no argument", async () => {
    await withTempHome(async (home) => {
      const text = await runThinkDirectiveAndGetText(home);
      expect(text).toContain("Current thinking level: high");
      expect(text).toContain("Options: off, minimal, low, medium, high.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
