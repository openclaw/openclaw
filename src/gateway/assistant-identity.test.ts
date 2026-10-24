import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as identityFiles from "../agents/identity-file.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import { AVATAR_MAX_DATA_URL_CHARS } from "../shared/avatar-limits.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  DEFAULT_ASSISTANT_IDENTITY,
  resolveAssistantIdentity,
  resolveAssistantIdentityAvatar,
  resolveAssistantIdentityName,
} from "./assistant-identity.js";

function configured(identity: AgentConfig["identity"]) {
  return { agents: { entries: { main: { identity } } } } satisfies OpenClawConfig;
}
function resolve(cfg: OpenClawConfig, workspaceDir = "") {
  return resolveAssistantIdentity({ cfg, workspaceDir });
}
const dataUrl = () =>
  `data:image/svg+xml;base64,${Buffer.alloc(AVATAR_MAX_BYTES).toString("base64")}`;
afterEach(() => vi.restoreAllMocks());

describe("resolveAssistantIdentity", () => {
  it.each([
    { avatar: " https://example.com/avatar.png ", expected: "https://example.com/avatar.png" },
    { emoji: "🦞", expected: "🦞" },
    { avatar: "slack://avatar.png", emoji: "🦞", expected: "🦞" },
    { avatar: "slack://avatar.png", expected: "workspace.png" },
    { avatar: " ", expected: "workspace.png" },
  ])("preserves avatar-only source precedence: $expected", async ({ expected, ...identity }) => {
    vi.spyOn(identityFiles, "loadAgentIdentityFromWorkspaceAsync").mockResolvedValue({
      avatar: "workspace.png",
    });
    expect(
      await resolveAssistantIdentityAvatar({
        cfg: configured(identity),
        workspaceDir: "/synthetic/workspace",
      }),
    ).toEqual({ agentId: "main", avatar: expected });
  });

  it("reads workspace fallbacks only when configured identity leaves a field unresolved", async () => {
    const read = vi
      .spyOn(identityFiles, "loadAgentIdentityFromWorkspaceAsync")
      .mockResolvedValue({ name: "Workspace", emoji: "🔭", avatar: "workspace.png" });
    const identity = { name: "Configured", emoji: "🦞", avatar: "avatar.png" };
    const cfg = configured(identity);
    expect(await resolve(cfg, "/synthetic/workspace")).toEqual({
      agentId: "main",
      name: "Configured",
      nameSource: "agent",
      avatar: "avatar.png",
      emoji: "🦞",
    });
    expect(read).not.toHaveBeenCalled();
    identity.emoji = "";
    expect(await resolve(cfg, "/synthetic/workspace")).toMatchObject({
      name: "Configured",
      avatar: "avatar.png",
      emoji: "🔭",
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "implicit main", cfg: {}, agentId: undefined, expected: "main" },
    {
      name: "first entry for ownerless presentation",
      cfg: { agents: { ownership: "explicit" as const, entries: { ops: {}, research: {} } } },
      agentId: undefined,
      expected: "ops",
    },
    {
      name: "normalized explicit selection",
      cfg: { agents: { ownership: "explicit" as const, entries: { ops: {}, research: {} } } },
      agentId: "RESEARCH",
      expected: "research",
    },
  ])("uses $name for presentation", async ({ cfg, agentId, expected }) => {
    expect(await resolveAssistantIdentity({ cfg, agentId, workspaceDir: "" })).toEqual({
      ...DEFAULT_ASSISTANT_IDENTITY,
      agentId: expected,
      nameSource: "default",
    });
  });

  it("drops sentence-like avatar placeholders", async () => {
    const cfg = configured({ avatar: "workspace-relative path, http(s) URL, or data URI" });
    expect((await resolve(cfg)).avatar).toBe(DEFAULT_ASSISTANT_IDENTITY.avatar);
  });

  it.each([false, true])(
    "honors the IDENTITY.md data URL cap (oversized=%s)",
    async (oversized) => {
      await withTestDir({ prefix: "openclaw-assistant-identity-cap-" }, async (workspace) => {
        const avatar = dataUrl() + (oversized ? "A" : "");
        expect(avatar).toHaveLength(AVATAR_MAX_DATA_URL_CHARS + Number(oversized));
        await fs.writeFile(
          path.join(workspace, "IDENTITY.md"),
          `- Avatar: ${avatar}\n- Emoji: 🦞\n`,
        );
        const cfg = {};
        const first = await resolve(cfg, workspace);
        expect(first.avatar).toBe(oversized ? "🦞" : avatar);
        expect(await resolve(cfg, workspace)).toBe(first);
      });
    },
  );

  it.each(["data:text/plain,avatar", "slack://avatar.png"])(
    "uses the configured emoji when the agent avatar is unsupported: %s",
    async (avatar) => {
      expect((await resolve(configured({ avatar, emoji: "🦞" }))).avatar).toBe("🦞");
    },
  );

  it("does not leave a lone surrogate when truncating an overlong name", async () => {
    for (const resolver of [resolveAssistantIdentity, resolveAssistantIdentityName]) {
      const resolveName = async (name: string) =>
        (await resolver({ cfg: configured({ name }), workspaceDir: "" })).name;
      const prefix = "x".repeat(49);
      const name = await resolveName(`${prefix}🚀suffix`);
      expect(name).toBe(prefix);
      expect(name.endsWith("\ud83d")).toBe(false);
      expect(await resolveName(`${"x".repeat(48)}🚀suffix`)).toBe(`${"x".repeat(48)}🚀`);
    }
  });

  it("refreshes prepared identities after workspace replacement and config changes", async () => {
    await withTestDir({ prefix: "openclaw-assistant-prepared-" }, async (workspace) => {
      const file = path.join(workspace, "IDENTITY.md");
      await fs.writeFile(file, "- Name: First\n");
      const identity: NonNullable<AgentConfig["identity"]> = { emoji: "🦞" };
      const cfg: OpenClawConfig = { agents: { entries: { main: { workspace, identity } } } };
      const params = { cfg, agentId: "main" };
      const read = () => resolveAssistantIdentity(params);
      const expectName = async (name: string) => {
        expect(await resolveAssistantIdentityName(params)).toEqual({ agentId: "main", name });
      };
      const first = await read();
      expect(first).toMatchObject({ name: "First", nameSource: "workspace" });
      await expectName("First");
      expect(await read()).toBe(first);
      await fs.writeFile(`${file}.replacement`, "- Name: Other\n");
      await fs.rename(`${file}.replacement`, file);
      const replaced = await read();
      expect(replaced.name).toBe("Other");
      expect(replaced).not.toBe(first);
      await expectName("Other");
      identity.name = "Configured";
      const current = await read();
      expect(current).toMatchObject({ name: "Configured", nameSource: "agent" });
      await expectName("Configured");
    });
  });
});
