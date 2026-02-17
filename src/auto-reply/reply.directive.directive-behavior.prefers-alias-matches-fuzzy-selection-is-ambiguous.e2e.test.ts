import "./reply.directive.directive-behavior.e2e-mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import {
  assertModelSelection,
  installDirectiveBehaviorE2EHooks,
  MAIN_SESSION_KEY,
  runEmbeddedPiAgent,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it("prefers alias matches when fuzzy selection is ambiguous", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model ki", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-5" },
              workspace: path.join(home, "openclaw"),
              models: {
                "anthropic/claude-opus-4-5": {},
                "moonshot/kimi-k2-0905-preview": { alias: "Kimi" },
                "lmstudio/kimi-k2-0905-preview": {},
              },
            },
          },
          models: {
            mode: "merge",
            providers: {
              moonshot: {
                baseUrl: "https://api.moonshot.ai/v1",
                apiKey: "sk-test",
                api: "openai-completions",
                models: [{ id: "kimi-k2-0905-preview", name: "Kimi K2" }],
              },
              lmstudio: {
                baseUrl: "http://127.0.0.1:1234/v1",
                apiKey: "lmstudio",
                api: "openai-responses",
                models: [{ id: "kimi-k2-0905-preview", name: "Kimi K2 (Local)" }],
              },
            },
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to Kimi (moonshot/kimi-k2-0905-preview).");
      assertModelSelection(storePath, {
        provider: "moonshot",
        model: "kimi-k2-0905-preview",
      });
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("stores auth profile overrides on /model directive", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const authDir = path.join(home, ".openclaw", "agents", "main", "agent");
      await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(authDir, "auth-profiles.json"),
        JSON.stringify(
          {
            version: 1,
            profiles: {
              "anthropic:work": {
                type: "api_key",
                provider: "anthropic",
                key: "sk-test-1234567890",
              },
            },
          },
          null,
          2,
        ),
      );

      const res = await getReplyFromConfig(
        { Body: "/model Opus@anthropic:work", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-4.1-mini" },
              workspace: path.join(home, "openclaw"),
              models: {
                "openai/gpt-4.1-mini": {},
                "anthropic/claude-opus-4-5": { alias: "Opus" },
              },
            },
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Auth profile set to anthropic:work");
      const store = loadSessionStore(storePath);
      const entry = store["agent:main:main"];
      expect(entry.authProfileOverride).toBe("anthropic:work");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("queues a system event when switching models", async () => {
    await withTempHome(async (home) => {
      drainSystemEvents(MAIN_SESSION_KEY);
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        { Body: "/model Opus", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-4.1-mini" },
              workspace: path.join(home, "openclaw"),
              models: {
                "openai/gpt-4.1-mini": {},
                "anthropic/claude-opus-4-5": { alias: "Opus" },
              },
            },
          },
          session: { store: storePath },
        },
      );

      const events = drainSystemEvents(MAIN_SESSION_KEY);
      expect(events).toContain("Model switched to Opus (anthropic/claude-opus-4-5).");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("queues a system event when toggling elevated", async () => {
    await withTempHome(async (home) => {
      drainSystemEvents(MAIN_SESSION_KEY);
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          CommandAuthorized: true,
        },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-4.1-mini" },
              workspace: path.join(home, "openclaw"),
            },
          },
          tools: { elevated: { allowFrom: { whatsapp: ["*"] } } },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      const events = drainSystemEvents(MAIN_SESSION_KEY);
      expect(events.some((e) => e.includes("Elevated ASK"))).toBe(true);
    });
  });
  it("queues a system event when toggling reasoning", async () => {
    await withTempHome(async (home) => {
      drainSystemEvents(MAIN_SESSION_KEY);
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        {
          Body: "/reasoning stream",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          CommandAuthorized: true,
        },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-4.1-mini" },
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      const events = drainSystemEvents(MAIN_SESSION_KEY);
      expect(events.some((e) => e.includes("Reasoning STREAM"))).toBe(true);
    });
  });
});
