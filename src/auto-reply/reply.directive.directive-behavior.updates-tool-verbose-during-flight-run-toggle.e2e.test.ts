import "./reply.directive.directive-behavior.e2e-mocks.js";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore, resolveSessionKey, saveSessionStore } from "../config/sessions.js";
import {
  installDirectiveBehaviorE2EHooks,
  runEmbeddedPiAgent,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it("updates tool verbose during an in-flight run (toggle on)", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const ctx = { Body: "please do the thing", From: "+1004", To: "+2000" };
      const sessionKey = resolveSessionKey(
        "per-sender",
        { From: ctx.From, To: ctx.To, Body: ctx.Body },
        "main",
      );

      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        const shouldEmit = params.shouldEmitToolResult;
        expect(shouldEmit?.()).toBe(false);
        const store = loadSessionStore(storePath);
        const entry = store[sessionKey] ?? {
          sessionId: "s",
          updatedAt: Date.now(),
        };
        store[sessionKey] = {
          ...entry,
          verboseLevel: "on",
          updatedAt: Date.now(),
        };
        await saveSessionStore(storePath, store);
        expect(shouldEmit?.()).toBe(true);
        return {
          payloads: [{ text: "done" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      });

      const res = await getReplyFromConfig(
        ctx,
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      const texts = (Array.isArray(res) ? res : [res]).map((entry) => entry?.text).filter(Boolean);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });
  it("updates tool verbose during an in-flight run (toggle off)", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
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

      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        const shouldEmit = params.shouldEmitToolResult;
        expect(shouldEmit?.()).toBe(true);
        const store = loadSessionStore(storePath);
        const entry = store[sessionKey] ?? {
          sessionId: "s",
          updatedAt: Date.now(),
        };
        store[sessionKey] = {
          ...entry,
          verboseLevel: "off",
          updatedAt: Date.now(),
        };
        await saveSessionStore(storePath, store);
        expect(shouldEmit?.()).toBe(false);
        return {
          payloads: [{ text: "done" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      });

      await getReplyFromConfig(
        { Body: "/verbose on", From: ctx.From, To: ctx.To, CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      const res = await getReplyFromConfig(
        ctx,
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      const texts = (Array.isArray(res) ? res : [res]).map((entry) => entry?.text).filter(Boolean);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });
  it("shows summary on /model", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-5" },
              workspace: path.join(home, "openclaw"),
              models: {
                "anthropic/claude-opus-4-5": {},
                "openai/gpt-4.1-mini": {},
              },
            },
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
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
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model status", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-5" },
              workspace: path.join(home, "openclaw"),
              models: {
                "anthropic/claude-opus-4-5": {},
                "openai/gpt-4.1-mini": {},
              },
            },
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("anthropic/claude-opus-4-5");
      expect(text).toContain("openai/gpt-4.1-mini");
      expect(text).not.toContain("claude-sonnet-4-1");
      expect(text).toContain("auth:");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
