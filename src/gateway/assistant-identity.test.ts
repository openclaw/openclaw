import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as identityFiles from "../agents/identity-file.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
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

it.each([
  [{ avatar: " https://example.com/avatar.png " }, "https://example.com/avatar.png"],
  [{ emoji: "🦞" }, "🦞"],
  [{ avatar: "slack://avatar.png", emoji: "🦞" }, "🦞"],
  [{ avatar: "data:text/plain,avatar", emoji: "🦞" }, "🦞"],
  [{ avatar: "slack://avatar.png" }, "workspace.png"],
  [{ avatar: " " }, "workspace.png"],
] as const)("preserves avatar source precedence: %j", async (identity, avatar) => {
  vi.spyOn(identityFiles, "loadAgentIdentityFromWorkspaceAsync").mockResolvedValue({
    avatar: "workspace.png",
  });
  const params = { cfg: configured(identity), workspaceDir: "/synthetic/workspace" };
  expect(await resolveAssistantIdentityAvatar(params)).toEqual({ agentId: "main", avatar });
  expect((await resolveAssistantIdentity(params)).avatar).toBe(avatar);
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

const roster = { agents: { ownership: "explicit", entries: { ops: {}, research: {} } } } as const;
it.each([
  [{}, undefined, "main"],
  [roster, undefined, "ops"],
  [roster, "RESEARCH", "research"],
] as const)("selects the presentation agent (%j, %s)", async (cfg, agentId, expected) => {
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

it.each([false, true])("honors the IDENTITY.md data URL cap (oversized=%s)", async (oversized) => {
  await withTestDir({ prefix: "openclaw-assistant-identity-cap-" }, async (workspace) => {
    const avatar = dataUrl() + (oversized ? "A" : "");
    await fs.writeFile(path.join(workspace, "IDENTITY.md"), `- Avatar: ${avatar}\n- Emoji: 🦞\n`);
    expect((await resolve({}, workspace)).avatar).toBe(oversized ? "🦞" : avatar);
  });
});

it("does not leave a lone surrogate when truncating an overlong name", async () => {
  for (const resolver of [resolveAssistantIdentity, resolveAssistantIdentityName]) {
    const resolveName = async (name: string) =>
      (await resolver({ cfg: configured({ name }), workspaceDir: "" })).name;
    const prefix = "x".repeat(49);
    const name = await resolveName(`${prefix}🚀suffix`);
    expect(name).toBe(prefix);
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
    expect(await read()).toMatchObject({ name: "Other" });
    expect(await read()).not.toBe(first);
    await expectName("Other");
    identity.name = "Configured";
    expect(await read()).toMatchObject({ name: "Configured", nameSource: "agent" });
    await expectName("Configured");
  });
});
