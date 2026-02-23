import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore, resolveSessionKey, saveSessionStore } from "../config/sessions.js";
import {
  installDirectiveBehaviorE2EHooks,
  makeEmbeddedTextResult,
  makeWhatsAppDirectiveConfig,
  replyTexts,
  runEmbeddedPiAgent,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { runModelDirectiveText } from "./reply.directive.directive-behavior.model-directive-test-utils.js";
import { getReplyFromConfig } from "./reply.js";

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
  it("shows summary on /model", async () => {
    await withTempHome(async (home) => {
      const text = await runModelDirectiveText(home, "/model", { includeSessionStore: false });
      expect(text).toContain("Current: anthropic/claude-opus-4-5");
      expect(text).toContain("Switch: /model <provider/model>");
      expect(text).toContain("Browse: /models (providers) or /models <provider> (models)");
      expect(text).toContain("More: /model status");
      expect(text).not.toContain("openai/gpt-4.1-mini");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("lists allowlisted models on /model status", async () => {
    await withTempHome(async (home) => {
      const text = await runModelDirectiveText(home, "/model status", {
        includeSessionStore: false,
      });
      expect(text).toContain("anthropic/claude-opus-4-5");
      expect(text).toContain("openai/gpt-4.1-mini");
      expect(text).not.toContain("claude-sonnet-4-1");
      expect(text).toContain("auth:");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
