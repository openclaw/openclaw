import "./reply.directive.directive-behavior.e2e-mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  installDirectiveBehaviorE2EHooks,
  runEmbeddedPiAgent,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

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

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  it("accepts /thinking xhigh for codex models", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        {
          Body: "/thinking xhigh",
          From: "+1004",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        {
          agents: {
            defaults: {
              model: "openai-codex/gpt-5.2-codex",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      const texts = (Array.isArray(res) ? res : [res]).map((entry) => entry?.text).filter(Boolean);
      expect(texts).toContain("Thinking level set to xhigh.");
    });
  });
  it("accepts /thinking xhigh for openai gpt-5.2", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        {
          Body: "/thinking xhigh",
          From: "+1004",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        {
          agents: {
            defaults: {
              model: "openai/gpt-5.2",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      const texts = (Array.isArray(res) ? res : [res]).map((entry) => entry?.text).filter(Boolean);
      expect(texts).toContain("Thinking level set to xhigh.");
    });
  });
  it("rejects /thinking xhigh for non-codex models", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        {
          Body: "/thinking xhigh",
          From: "+1004",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        {
          agents: {
            defaults: {
              model: "openai/gpt-4.1-mini",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      const texts = (Array.isArray(res) ? res : [res]).map((entry) => entry?.text).filter(Boolean);
      expect(texts).toContain(
        'Thinking level "xhigh" is only supported for openai/gpt-5.2, openai-codex/gpt-5.3-codex, openai-codex/gpt-5.3-codex-spark, openai-codex/gpt-5.2-codex, openai-codex/gpt-5.1-codex, github-copilot/gpt-5.2-codex or github-copilot/gpt-5.2.',
      );
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
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
              models: {
                "anthropic/claude-opus-4-5": { alias: " help " },
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Help");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
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
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace,
              models: {
                "anthropic/claude-opus-4-5": { alias: "demo_skill" },
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      const prompt = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain('Use the "demo-skill" skill');
    });
  });
  it("errors on invalid queue options", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/queue collect debounce:bogus cap:zero drop:maybe",
          From: "+1222",
          To: "+1222",
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
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Invalid debounce");
      expect(text).toContain("Invalid cap");
      expect(text).toContain("Invalid drop policy");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("shows current queue settings when /queue has no arguments", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/queue",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
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
          messages: {
            queue: {
              mode: "collect",
              debounceMs: 1500,
              cap: 9,
              drop: "summarize",
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain(
        "Current queue settings: mode=collect, debounce=1500ms, cap=9, drop=summarize.",
      );
      expect(text).toContain(
        "Options: modes steer, followup, collect, steer+backlog, interrupt; debounce:<ms|s|m>, cap:<n>, drop:old|new|summarize.",
      );
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("shows current think level when /think has no argument", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        { Body: "/think", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
              thinkingDefault: "high",
            },
          },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current thinking level: high");
      expect(text).toContain("Options: off, minimal, low, medium, high.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
