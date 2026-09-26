/**
 * Assistant identity resolution tests for gateway-visible agents.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { AVATAR_MAX_DATA_URL_CHARS } from "../shared/avatar-limits.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";

describe("resolveAssistantIdentity", () => {
  it("uses the selected agent identity", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", identity: { name: "Main agent", avatar: "M" } },
          { id: "worker", identity: { name: "Worker agent", avatar: "W" } },
        ],
      },
    };

    const identity = await resolveAssistantIdentity({ cfg, agentId: "worker", workspaceDir: "" });
    expect(identity.agentId).toBe("worker");
    expect(identity.name).toBe("Worker agent");
    expect(identity.nameSource).toBe("agent");
    expect(identity.avatar).toBe("W");
  });

  it.each<{
    name: string;
    cfg: OpenClawConfig;
    agentId?: string;
    expected: string;
  }>([
    { name: "implicit main", cfg: {}, expected: "main" },
    { name: "sole agent", cfg: { agents: { entries: { research: {} } } }, expected: "research" },
    {
      name: "recorded explicit default owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
          defaults: { systemAgent: { agentId: "research" } },
        },
      },
      expected: "research",
    },
    {
      name: "first entry for ownerless presentation",
      cfg: { agents: { ownership: "explicit", entries: { ops: {}, research: {} } } },
      expected: "ops",
    },
    {
      name: "retained legacy owner",
      cfg: retainLegacyDefaultAgentId(
        { agents: { entries: { ops: {}, research: {} } } },
        "research",
      ),
      expected: "research",
    },
    {
      name: "first entry for undesignated explicit presentation despite provenance",
      cfg: retainLegacyDefaultAgentId(
        { agents: { ownership: "explicit", entries: { ops: {}, research: {} } } },
        "research",
      ),
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

  it("identifies workspace and synthesized default names", async () => {
    await withTestDir({ prefix: "openclaw-assistant-identity-name-source-" }, async (workspace) => {
      await fs.writeFile(path.join(workspace, "IDENTITY.md"), "- Name: Pacino\n");

      expect(
        (await resolveAssistantIdentity({ cfg: {}, workspaceDir: workspace })).nameSource,
      ).toBe("workspace");
      expect((await resolveAssistantIdentity({ cfg: {}, workspaceDir: "" })).nameSource).toBe(
        "default",
      );
    });
  });

  it("drops sentence-like avatar placeholders", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            identity: { avatar: "workspace-relative path, http(s) URL, or data URI" },
          },
        ],
      },
    };

    expect((await resolveAssistantIdentity({ cfg, workspaceDir: "" })).avatar).toBe(
      DEFAULT_ASSISTANT_IDENTITY.avatar,
    );
  });

  it("keeps path avatars", async () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { avatar: "avatars/openclaw.png" } }] },
    };

    expect((await resolveAssistantIdentity({ cfg, workspaceDir: "" })).avatar).toBe(
      "avatars/openclaw.png",
    );
  });

  it("preserves long image data URLs without truncating past 200 chars", async () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(50_000)}`;
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { avatar: dataUrl } }] },
    };

    expect((await resolveAssistantIdentity({ cfg, workspaceDir: "" })).avatar).toBe(dataUrl);
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

  it("rejects a non-image IDENTITY.md data URL and uses its emoji fallback", async () => {
    await withTestDir({ prefix: "openclaw-assistant-identity-data-type-" }, async (workspace) => {
      await fs.writeFile(
        path.join(workspace, "IDENTITY.md"),
        "- Avatar: data:text/plain,avatar\n- Emoji: 🦞\n",
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
        agents: { list: [{ id: "main", identity: { avatar, emoji: "🦞" } }] },
      };

      expect((await resolveAssistantIdentity({ cfg, workspaceDir: "" })).avatar).toBe("🦞");
    },
  );

  it("lets a valid IDENTITY.md avatar win when the agent URI scheme is unsupported", async () => {
    await withTestDir({ prefix: "openclaw-assistant-identity-fallback-" }, async (workspace) => {
      await fs.writeFile(path.join(workspace, "IDENTITY.md"), "- Avatar: identity.png\n");
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "main", workspace, identity: { avatar: "slack://avatar.png" } }],
        },
      };

      expect((await resolveAssistantIdentity({ cfg, workspaceDir: workspace })).avatar).toBe(
        "identity.png",
      );
    });
  });

  it("does not leave a lone surrogate when truncating an overlong name", async () => {
    const resolveName = async (name: string) =>
      (
        await resolveAssistantIdentity({
          cfg: { agents: { list: [{ id: "main", identity: { name } }] } },
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
      expect((await resolveAssistantIdentity({ cfg, agentId: "main" })).name).toBe("Configured");
    });
  });
});
