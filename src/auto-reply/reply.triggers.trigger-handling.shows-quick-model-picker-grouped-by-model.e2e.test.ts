import { beforeAll, describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { loadSessionStore } from "../config/sessions.js";
import {
  installTriggerHandlingE2eTestHooks,
  makeCfg,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  ({ getReplyFromConfig } = await import("./reply.js"));
});

installTriggerHandlingE2eTestHooks();

const DEFAULT_SESSION_KEY = "telegram:slash:111";

function makeTelegramModelCommand(body: string, sessionKey = DEFAULT_SESSION_KEY) {
  return {
    Body: body,
    From: "telegram:111",
    To: "telegram:111",
    ChatType: "direct" as const,
    Provider: "telegram" as const,
    Surface: "telegram" as const,
    SessionKey: sessionKey,
    CommandAuthorized: true,
  };
}

function firstReplyText(reply: Awaited<ReturnType<typeof getReplyFromConfig>>) {
  return Array.isArray(reply) ? (reply[0]?.text ?? "") : (reply?.text ?? "");
}

async function runModelCommand(home: string, body: string, sessionKey = DEFAULT_SESSION_KEY) {
  const cfg = makeCfg(home);
  const res = await getReplyFromConfig(makeTelegramModelCommand(body, sessionKey), {}, cfg);
  const text = firstReplyText(res);
  return {
    cfg,
    sessionKey,
    text,
    normalized: normalizeTestText(text),
  };
}

describe("trigger handling", () => {
  it("shows a /model summary and points to /models", async () => {
    await withTempHome(async (home) => {
      const { normalized } = await runModelCommand(home, "/model");

      expect(normalized).toContain("Current: anthropic/claude-opus-4-5");
      expect(normalized).toContain("/model <provider/model> to switch");
      expect(normalized).toContain("Tap below to browse models");
      expect(normalized).toContain("/model status for details");
      expect(normalized).not.toContain("reasoning");
      expect(normalized).not.toContain("image");
    });
  });

  it("aliases /model list to /models", async () => {
    await withTempHome(async (home) => {
      const { normalized } = await runModelCommand(home, "/model list");

      expect(normalized).toContain("Providers:");
      expect(normalized).toContain("Use: /models <provider>");
      expect(normalized).toContain("Switch: /model <provider/model>");
    });
  });

  it("selects the exact provider/model pair for openrouter", async () => {
    await withTempHome(async (home) => {
      const { cfg, sessionKey, normalized } = await runModelCommand(
        home,
        "/model openrouter/anthropic/claude-opus-4-5",
      );

      expect(normalized).toContain("Model set to openrouter/anthropic/claude-opus-4-5");

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBe("openrouter");
      expect(store[sessionKey]?.modelOverride).toBe("anthropic/claude-opus-4-5");
    });
  });

  it("rejects invalid /model <#> selections", async () => {
    await withTempHome(async (home) => {
      const { cfg, sessionKey, normalized } = await runModelCommand(home, "/model 99");

      expect(normalized).toContain("Numeric model selection is not supported in chat.");
      expect(normalized).toContain("Browse: /models or /models <provider>");
      expect(normalized).toContain("Switch: /model <provider/model>");

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBeUndefined();
      expect(store[sessionKey]?.modelOverride).toBeUndefined();
    });
  });

  it("resets to the default model via /model <provider/model>", async () => {
    await withTempHome(async (home) => {
      const { cfg, sessionKey, normalized } = await runModelCommand(
        home,
        "/model anthropic/claude-opus-4-5",
      );

      expect(normalized).toContain("Model reset to default (anthropic/claude-opus-4-5)");

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBeUndefined();
      expect(store[sessionKey]?.modelOverride).toBeUndefined();
    });
  });

  it("selects a model via /model <provider/model>", async () => {
    await withTempHome(async (home) => {
      const { cfg, sessionKey, normalized } = await runModelCommand(home, "/model openai/gpt-5.2");

      expect(normalized).toContain("Model set to openai/gpt-5.2");

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBe("openai");
      expect(store[sessionKey]?.modelOverride).toBe("gpt-5.2");
    });
  });
});
