/**
 * Assistant identity resolution tests for gateway-visible agents.
 */
import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { AVATAR_MAX_DATA_URL_CHARS } from "../shared/avatar-limits.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";

describe("resolveAssistantIdentity", () => {
  it.each<{
    name: string;
    cfg: OpenClawConfig;
    agentId?: string;
    expected: string;
  }>([
    { name: "implicit main", cfg: {}, expected: "main" },
    {
      name: "first entry for ownerless presentation",
      cfg: { agents: { ownership: "explicit", entries: { ops: {}, research: {} } } },
      expected: "ops",
    },
    {
      name: "normalized explicit selection",
      cfg: { agents: { ownership: "explicit", entries: { ops: {}, research: {} } } },
      agentId: "RESEARCH",
      expected: "research",
    },
  ])("uses $name for presentation", async ({ cfg, agentId, expected }) => {
    const identity = await resolveAssistantIdentity({
      cfg,
      agentId,
      workspaceDir: "",
    });

    expect(identity).toEqual({
      ...DEFAULT_ASSISTANT_IDENTITY,
      agentId: expected,
      nameSource: "default",
    });
  });

  it("drops sentence-like avatar placeholders", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: {
            identity: { avatar: "workspace-relative path, http(s) URL, or data URI" },
          },
        },
      },
    };

    expect((await resolveAssistantIdentity({ cfg, workspaceDir: "" })).avatar).toBe(
      DEFAULT_ASSISTANT_IDENTITY.avatar,
    );
  });

  it("preserves an exact shared-cap IDENTITY.md data URL without truncation", async () => {
    await withTestDir({ prefix: "openclaw-assistant-identity-cap-" }, async (workspace) => {
      const dataUrl = `data:image/svg+xml;base64,${Buffer.alloc(AVATAR_MAX_BYTES).toString("base64")}`;
      expect(dataUrl).toHaveLength(AVATAR_MAX_DATA_URL_CHARS);
      await fs.writeFile(path.join(workspace, "IDENTITY.md"), `- Avatar: ${dataUrl}\n`);

      const cfg = {};
      const first = await resolveAssistantIdentity({ cfg, workspaceDir: workspace });
      expect(first.avatar).toBe(dataUrl);
      expect(await resolveAssistantIdentity({ cfg, workspaceDir: workspace })).toBe(first);
    });
  });

  it("rejects an oversized IDENTITY.md data URL without truncating it", async () => {
    await withTestDir({ prefix: "openclaw-assistant-identity-overflow-" }, async (workspace) => {
      const exact = `data:image/svg+xml;base64,${Buffer.alloc(AVATAR_MAX_BYTES).toString("base64")}`;
      const oversized = `${exact}A`;
      expect(oversized).toHaveLength(AVATAR_MAX_DATA_URL_CHARS + 1);
      await fs.writeFile(
        path.join(workspace, "IDENTITY.md"),
        `- Avatar: ${oversized}\n- Emoji: 🦞\n`,
      );

      expect((await resolveAssistantIdentity({ cfg: {}, workspaceDir: workspace })).avatar).toBe(
        "🦞",
      );
    });
  });

  it.each(["data:text/plain,avatar", "slack://avatar.png"])(
    "uses the configured emoji when the agent avatar is unsupported: %s",
    async (avatar) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { identity: { avatar, emoji: "🦞" } } } },
      };

      expect((await resolveAssistantIdentity({ cfg, workspaceDir: "" })).avatar).toBe("🦞");
    },
  );

  it("does not leave a lone surrogate when truncating an overlong name", async () => {
    const resolveName = async (name: string) =>
      (
        await resolveAssistantIdentity({
          cfg: { agents: { entries: { main: { identity: { name } } } } },
          agentId: "main",
          workspaceDir: "",
        })
      ).name;
    const prefix = "x".repeat(49);
    const name = await resolveName(`${prefix}🚀suffix`);
    expect(name).toBe(prefix);
    expect(name.endsWith("\ud83d")).toBe(false);
    expect(await resolveName(`${"x".repeat(48)}🚀suffix`)).toBe(`${"x".repeat(48)}🚀`);
  });

  it("refreshes prepared identities after workspace replacement and config changes", async () => {
    await withTestDir({ prefix: "openclaw-assistant-prepared-" }, async (workspace) => {
      const file = path.join(workspace, "IDENTITY.md");
      await fs.writeFile(file, "- Name: First\n");
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { workspace, identity: { emoji: "🦞" } } } },
      };
      const first = await resolveAssistantIdentity({ cfg, agentId: "main" });
      expect(first.name).toBe("First");
      expect(first.nameSource).toBe("workspace");
      expect(await resolveAssistantIdentity({ cfg, agentId: "main" })).toBe(first);
      await fs.writeFile(`${file}.replacement`, "- Name: Other\n");
      await fs.rename(`${file}.replacement`, file);
      const replaced = await resolveAssistantIdentity({ cfg, agentId: "main" });
      expect(replaced.name).toBe("Other");
      expect(replaced).not.toBe(first);
      const configIdentity = cfg.agents?.entries?.main?.identity;
      if (!configIdentity) {
        throw new Error("Missing fixture identity");
      }
      configIdentity.name = "Configured";
      expect(await resolveAssistantIdentity({ cfg, agentId: "main" })).toMatchObject({
        name: "Configured",
        nameSource: "agent",
      });
    });
  });
});
