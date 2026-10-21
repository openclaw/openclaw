import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayAssistantAvatar } from "./assistant-avatar.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";

const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG.toString("base64")}`;
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function createWorkspace(identity: { avatar?: string; emoji?: string } = {}) {
  const root = tempRoots.make("openclaw-gateway-avatar-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const cfg: OpenClawConfig = { agents: { entries: { main: { workspace, identity } } } };
  return {
    workspace,
    cfg,
    project: async () =>
      resolveGatewayAssistantAvatar({
        cfg,
        identity: await resolveAssistantIdentity({ cfg, agentId: "main" }),
      }),
  };
}

function projectSelected(avatar: string, cfg = createWorkspace().cfg) {
  return resolveGatewayAssistantAvatar({ cfg, identity: { agentId: "main", avatar, emoji: "🦞" } });
}

it("inlines the selected local file", async () => {
  const { project, workspace } = createWorkspace({ avatar: "avatar.png" });
  fs.writeFileSync(path.join(workspace, "avatar.png"), REAL_PNG);

  expect(await project()).toMatchObject({
    avatar: REAL_PNG_DATA_URL,
    resolution: { kind: "local", source: "avatar.png" },
  });
});

it("preserves a selected emoji over a lower-priority IDENTITY.md file", async () => {
  const { project, workspace } = createWorkspace({ emoji: "🦞" });
  fs.writeFileSync(path.join(workspace, "identity.png"), REAL_PNG);
  fs.writeFileSync(path.join(workspace, "IDENTITY.md"), "- Avatar: identity.png\n");

  expect(await project()).toEqual({ avatar: "🦞", resolution: null });
});

it.each([
  ["remote URL", "https://example.com/avatar.png"],
  ["data URI", REAL_PNG_DATA_URL],
])("preserves a selected %s", async (_name, avatar) => {
  expect(await createWorkspace({ avatar }).project()).toMatchObject({
    avatar,
    resolution: { source: avatar },
  });
});

it.each([
  ["data:text/plain,avatar", "unsupported_data_url"],
  ["slack://avatar.png", "unsupported_uri"],
  ["/avatar/main/extra", "outside_workspace"],
  ["//evil.example/avatar/main", "outside_workspace"],
  ["//[", "outside_workspace"],
  ["/avatar\\main", "outside_workspace"],
])("rejects selected avatar %s", async (avatar, reason) => {
  expect(await projectSelected(avatar)).toEqual({
    avatar: "🦞",
    resolution: { kind: "none", reason, source: avatar },
  });
});

it.each([undefined, "🦞"])(
  "uses the fallback for missing local avatars (emoji=%s)",
  async (emoji) => {
    expect(await createWorkspace({ avatar: "missing.png", emoji }).project()).toEqual({
      avatar: emoji ?? "A",
      resolution: { kind: "none", reason: "missing", source: "missing.png" },
    });
  },
);

it("reports pinned-read rejection instead of claiming the avatar is local", async () => {
  const { project, workspace } = createWorkspace({ avatar: "avatar.png" });
  fs.writeFileSync(path.join(workspace, "original.png"), REAL_PNG);
  fs.linkSync(path.join(workspace, "original.png"), path.join(workspace, "avatar.png"));

  expect(await project()).toEqual({
    avatar: "A",
    resolution: { kind: "none", reason: "unreadable", source: "avatar.png" },
  });
});

it.each(["/avatar/main", "/openclaw/avatar/main"])(
  "preserves same-origin route %s",
  async (avatar) => {
    const { cfg } = createWorkspace();
    cfg.gateway = { controlUi: { basePath: "/openclaw" } };

    expect(await projectSelected(avatar, cfg)).toEqual({
      avatar: "/openclaw/avatar/main",
      resolution: null,
    });
  },
);
