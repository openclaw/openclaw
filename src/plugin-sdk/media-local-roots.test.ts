// Plugin SDK media-root contract tests exercise the public helpers with the public loader.
import fs from "node:fs/promises";
import path from "node:path";
import {
  getAgentScopedMediaLocalRoots,
  getAgentScopedMediaLocalRootsForSources,
} from "openclaw/plugin-sdk/media-local-roots";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "./config-contracts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type SandboxFixture = Awaited<ReturnType<typeof createSandboxFixture>>;

async function createSandboxFixture() {
  const baseDir = tempDirs.make("plugin-sdk-media-roots-");
  const stateDir = path.join(baseDir, "state");
  const agentWorkspaceDir = path.join(baseDir, "workspace-main");
  const sessionWorkspaceDir = path.join(stateDir, "sandboxes", "active");
  const siblingWorkspaceDir = path.join(stateDir, "sandboxes", "sibling");
  const activeFile = path.join(sessionWorkspaceDir, "report.txt");
  const siblingFile = path.join(siblingWorkspaceDir, "secret.txt");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  await fs.mkdir(agentWorkspaceDir, { recursive: true });
  await fs.mkdir(sessionWorkspaceDir, { recursive: true });
  await fs.mkdir(siblingWorkspaceDir, { recursive: true });
  await fs.writeFile(activeFile, "active-report");
  await fs.writeFile(siblingFile, "sibling-secret");
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "main", workspace: agentWorkspaceDir }] },
    tools: { fs: { workspaceOnly: true } },
  };
  return { cfg, sessionWorkspaceDir, activeFile, siblingFile };
}

async function expectActiveAllowedAndSiblingDenied(
  fixture: SandboxFixture,
  localRoots: readonly string[],
) {
  const active = await loadWebMediaRaw(fixture.activeFile, { localRoots });
  expect(active.buffer.toString()).toBe("active-report");
  await expect(loadWebMediaRaw(fixture.siblingFile, { localRoots })).rejects.toThrow(
    /not under an allowed directory/i,
  );
}

describe("plugin SDK media local roots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("supports a fresh plugin caller using trusted active-session context", async () => {
    const fixture = await createSandboxFixture();
    const localRoots = getAgentScopedMediaLocalRootsForSources({
      cfg: fixture.cfg,
      agentId: "main",
      mediaSources: [fixture.activeFile, fixture.siblingFile],
      sessionWorkspaceDir: fixture.sessionWorkspaceDir,
    });

    await expectActiveAllowedAndSiblingDenied(fixture, localRoots);
  });

  it("supports an upgraded positional-helper caller using trusted active-session context", async () => {
    const fixture = await createSandboxFixture();
    const localRoots = getAgentScopedMediaLocalRoots(
      fixture.cfg,
      "main",
      fixture.sessionWorkspaceDir,
    );

    await expectActiveAllowedAndSiblingDenied(fixture, localRoots);
  });

  it("keeps trusted session-context callers sandbox-capable when root expansion is enabled", async () => {
    // Exercises the newly confined expansion branch: with workspaceOnly disabled (the default),
    // a caller with trusted session context keeps parent expansion inside its own sandbox and
    // still cannot reach sibling sandboxes.
    const baseDir = tempDirs.make("plugin-sdk-media-roots-expansion-");
    const stateDir = path.join(baseDir, "state");
    const agentWorkspaceDir = path.join(baseDir, "workspace-main");
    const sessionWorkspaceDir = path.join(stateDir, "sandboxes", "active");
    const siblingWorkspaceDir = path.join(stateDir, "sandboxes", "sibling");
    const ownNestedFile = path.join(sessionWorkspaceDir, "media", "clip.txt");
    const siblingFile = path.join(siblingWorkspaceDir, "secret.txt");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await fs.mkdir(agentWorkspaceDir, { recursive: true });
    await fs.mkdir(path.dirname(ownNestedFile), { recursive: true });
    await fs.mkdir(siblingWorkspaceDir, { recursive: true });
    await fs.writeFile(ownNestedFile, "own-media");
    await fs.writeFile(siblingFile, "sibling-secret");
    try {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", workspace: agentWorkspaceDir }] },
      };
      const localRoots = getAgentScopedMediaLocalRootsForSources({
        cfg,
        agentId: "main",
        mediaSources: [ownNestedFile, siblingFile],
        sessionWorkspaceDir,
      });

      const own = await loadWebMediaRaw(ownNestedFile, { localRoots });
      expect(own.buffer.toString()).toBe("own-media");
      await expect(loadWebMediaRaw(siblingFile, { localRoots })).rejects.toThrow(
        /not under an allowed directory/i,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed for a legacy caller that omits active-session context", async () => {
    const fixture = await createSandboxFixture();
    const localRoots = getAgentScopedMediaLocalRoots(fixture.cfg, "main");

    await expect(loadWebMediaRaw(fixture.activeFile, { localRoots })).rejects.toThrow(
      /not under an allowed directory/i,
    );
    await expect(loadWebMediaRaw(fixture.siblingFile, { localRoots })).rejects.toThrow(
      /not under an allowed directory/i,
    );
  });
});
