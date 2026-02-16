import "./reply.directive.directive-behavior.e2e-mocks.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import {
  installDirectiveBehaviorE2EHooks,
  makeRestrictedElevatedDisabledConfig,
  runEmbeddedPiAgent,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  function extractReplyText(res: Awaited<ReturnType<typeof getReplyFromConfig>>): string {
    return (Array.isArray(res) ? res[0]?.text : res?.text) ?? "";
  }

  function makeQueueDirectiveConfig(home: string, storePath: string) {
    return {
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-5",
          workspace: path.join(home, "openclaw"),
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
  }

  async function runQueueDirective(params: { home: string; storePath: string; body: string }) {
    return await getReplyFromConfig(
      { Body: params.body, From: "+1222", To: "+1222", CommandAuthorized: true },
      {},
      makeQueueDirectiveConfig(params.home, params.storePath),
    );
  }

  it("returns status alongside directive-only acks", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        {
          Body: "/elevated off\n/status",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
          CommandAuthorized: true,
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          channels: { whatsapp: { allowFrom: ["+1222"] } },
          session: { store: storePath },
        },
      );

      const text = extractReplyText(res);
      expect(text).toContain("Elevated mode disabled.");
      expect(text).toContain("Session: agent:main:main");
      const optionsLine = text?.split("\n").find((line) => line.trim().startsWith("⚙️"));
      expect(optionsLine).toBeTruthy();
      expect(optionsLine).not.toContain("elevated");

      const store = loadSessionStore(storePath);
      expect(store["agent:main:main"]?.elevatedLevel).toBe("off");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("shows elevated off in status when per-agent elevated is disabled", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
          SessionKey: "agent:restricted:main",
          CommandAuthorized: true,
        },
        {},
        makeRestrictedElevatedDisabledConfig(home),
      );

      const text = extractReplyText(res);
      expect(text).not.toContain("elevated");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("acks queue directive and persists override", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await runQueueDirective({
        home,
        storePath,
        body: "/queue interrupt",
      });

      const text = extractReplyText(res);
      expect(text).toMatch(/^⚙️ Queue mode set to interrupt\./);
      const store = loadSessionStore(storePath);
      const entry = Object.values(store)[0];
      expect(entry?.queueMode).toBe("interrupt");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("persists queue options when directive is standalone", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await runQueueDirective({
        home,
        storePath,
        body: "/queue collect debounce:2s cap:5 drop:old",
      });

      const text = extractReplyText(res);
      expect(text).toMatch(/^⚙️ Queue mode set to collect\./);
      expect(text).toMatch(/Queue debounce set to 2000ms/);
      expect(text).toMatch(/Queue cap set to 5/);
      expect(text).toMatch(/Queue drop set to old/);
      const store = loadSessionStore(storePath);
      const entry = Object.values(store)[0];
      expect(entry?.queueMode).toBe("collect");
      expect(entry?.queueDebounceMs).toBe(2000);
      expect(entry?.queueCap).toBe(5);
      expect(entry?.queueDrop).toBe("old");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("resets queue mode to default", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      await runQueueDirective({ home, storePath, body: "/queue interrupt" });
      const res = await runQueueDirective({ home, storePath, body: "/queue reset" });
      const text = extractReplyText(res);
      expect(text).toMatch(/^⚙️ Queue mode reset to default\./);
      const store = loadSessionStore(storePath);
      const entry = Object.values(store)[0];
      expect(entry?.queueMode).toBeUndefined();
      expect(entry?.queueDebounceMs).toBeUndefined();
      expect(entry?.queueCap).toBeUndefined();
      expect(entry?.queueDrop).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
