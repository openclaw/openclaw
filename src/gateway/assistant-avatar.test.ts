// Gateway assistant-avatar tests cover selected-source precedence and safe fallbacks.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function createWorkspace(): { workspace: string; cfg: OpenClawConfig } {
  const root = tempRoots.make("openclaw-gateway-avatar-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  return {
    workspace,
    cfg: { agents: { list: [{ id: "main", workspace }] } },
  };
}

async function projectAvatar(cfg: OpenClawConfig) {
  const identity = await resolveAssistantIdentity({ cfg, agentId: "main" });
  return resolveGatewayAssistantAvatar({ cfg, identity });
}

describe("resolveGatewayAssistantAvatar", () => {
  it("inlines the selected local file", async () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "avatar.png"), REAL_PNG);
    cfg.agents!.list![0]!.identity = { avatar: "avatar.png" };

    expect(await projectAvatar(cfg)).toMatchObject({
      avatar: REAL_PNG_DATA_URL,
      resolution: { kind: "local", source: "avatar.png" },
    });
  });

  it("preserves a selected emoji over a lower-priority IDENTITY.md file", async () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "identity.png"), REAL_PNG);
    fs.writeFileSync(path.join(workspace, "IDENTITY.md"), "- Avatar: identity.png\n");
    cfg.agents!.list![0]!.identity = { emoji: "🦞" };

    expect(await projectAvatar(cfg)).toEqual({ avatar: "🦞", resolution: null });
  });

  it.each([
    ["remote URL", "https://example.com/avatar.png"],
    ["data URI", REAL_PNG_DATA_URL],
  ])("preserves a selected %s", async (_name, avatar) => {
    const { cfg } = createWorkspace();
    cfg.agents!.list![0]!.identity = { avatar };

    expect(await projectAvatar(cfg)).toMatchObject({ avatar, resolution: { source: avatar } });
  });

  it("uses a configured emoji when the selected local path is rejected", async () => {
    const { cfg } = createWorkspace();
    cfg.agents!.list![0]!.identity = { avatar: "missing.png", emoji: "🦞" };

    expect(await projectAvatar(cfg)).toEqual({
      avatar: "🦞",
      resolution: { kind: "none", reason: "missing", source: "missing.png" },
    });
  });

  it.each([
    ["unsupported_data_url", "data:text/plain,avatar"],
    ["unsupported_uri", "slack://avatar.png"],
  ])("rejects %s before local-path handling", async (reason, avatar) => {
    const { cfg } = createWorkspace();

    expect(
      await resolveGatewayAssistantAvatar({
        cfg,
        identity: { agentId: "main", avatar, emoji: "🦞" },
      }),
    ).toEqual({
      avatar: "🦞",
      resolution: { kind: "none", reason, source: avatar },
    });
  });

  it("never maps a rejected local path back to an authenticated avatar route", async () => {
    const { cfg } = createWorkspace();
    cfg.agents!.list![0]!.identity = { avatar: "missing.png" };

    expect(await projectAvatar(cfg)).toEqual({
      avatar: "A",
      resolution: { kind: "none", reason: "missing", source: "missing.png" },
    });
  });

  it("reports pinned-read rejection instead of claiming the avatar is local", async () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "original.png"), REAL_PNG);
    fs.linkSync(path.join(workspace, "original.png"), path.join(workspace, "avatar.png"));
    cfg.agents!.list![0]!.identity = { avatar: "avatar.png" };

    expect(await projectAvatar(cfg)).toEqual({
      avatar: "A",
      resolution: { kind: "none", reason: "unreadable", source: "avatar.png" },
    });
  });

  it.each(["PS", "🦞"])("keeps the %s text avatar free of file metadata", async (avatar) => {
    const { cfg } = createWorkspace();
    cfg.agents!.list![0]!.identity = { avatar };

    expect(await projectAvatar(cfg)).toEqual({ avatar, resolution: null });
  });

  it("preserves same-origin avatar routes and applies the configured base path", async () => {
    const { cfg } = createWorkspace();
    cfg.gateway = { controlUi: { basePath: "/openclaw" } };

    expect(
      await resolveGatewayAssistantAvatar({
        cfg,
        identity: { agentId: "main", avatar: "/avatar/main" },
      }),
    ).toEqual({ avatar: "/openclaw/avatar/main", resolution: null });
    expect(
      await resolveGatewayAssistantAvatar({
        cfg,
        identity: { agentId: "main", avatar: "/openclaw/avatar/main" },
      }),
    ).toEqual({ avatar: "/openclaw/avatar/main", resolution: null });
  });

  it.each(["/avatar/main/extra", "//evil.example/avatar/main", "//[", "/avatar\\main"])(
    "rejects non-canonical same-origin avatar path %s",
    async (avatar) => {
      const { cfg } = createWorkspace();

      expect(
        await resolveGatewayAssistantAvatar({
          cfg,
          identity: { agentId: "main", avatar, emoji: "🦞" },
        }),
      ).toEqual({
        avatar: "🦞",
        resolution: {
          kind: "none",
          reason: "outside_workspace",
          source: avatar,
        },
      });
    },
  );
});
