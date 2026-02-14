import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { loadSessionStore } from "../config/sessions.js";
import { getReplyFromConfig } from "./reply.js";
import {
  installTriggerHandlingE2eTestHooks,
  makeCfg,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("shows a /model summary and points to /models", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/model",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const normalized = normalizeTestText(text ?? "");
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
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/model list",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const normalized = normalizeTestText(text ?? "");
      expect(normalized).toContain("Providers:");
      expect(normalized).toContain("Use: /models <provider>");
      expect(normalized).toContain("Switch: /model <provider/model>");
    });
  });
  it("selects the exact provider/model pair for openrouter", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      const res = await getReplyFromConfig(
        {
          Body: "/model openrouter/anthropic/claude-opus-4-5",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain(
        "Model set to openrouter/anthropic/claude-opus-4-5",
      );

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBe("openrouter");
      expect(store[sessionKey]?.modelOverride).toBe("anthropic/claude-opus-4-5");
    });
  });
  it("rejects invalid /model <#> selections", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      const res = await getReplyFromConfig(
        {
          Body: "/model 99",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const normalized = normalizeTestText(text ?? "");
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
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      const res = await getReplyFromConfig(
        {
          Body: "/model anthropic/claude-opus-4-5",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain(
        "Model reset to default (anthropic/claude-opus-4-5)",
      );

      const store = loadSessionStore(cfg.session.store);
      // When selecting the default, overrides are cleared
      expect(store[sessionKey]?.providerOverride).toBeUndefined();
      expect(store[sessionKey]?.modelOverride).toBeUndefined();
    });
  });
  it("selects a model via /model <provider/model>", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      const res = await getReplyFromConfig(
        {
          Body: "/model openai/gpt-5.2",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain("Model set to openai/gpt-5.2");

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBe("openai");
      expect(store[sessionKey]?.modelOverride).toBe("gpt-5.2");
    });
  });
});
