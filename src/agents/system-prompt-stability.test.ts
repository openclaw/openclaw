// System prompt stability tests cover deterministic workspace bootstrap file
// loading so prompt-cache inputs stay byte-stable.

import { describe, expect, it, beforeEach } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  loadWorkspaceBootstrapFiles,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
} from "./workspace.js";

describe("system prompt stability for cache hits", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await makeTempWorkspace("openclaw-system-prompt-stability-");
  });

  it("returns identical results for same inputs across multiple calls", async () => {
    const agentsContent = "# AGENTS.md - Your Workspace\n\nTest agents file.";
    const soulContent = "# SOUL.md - Who You Are\n\nTest soul file.";

    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: agentsContent,
    });
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_SOUL_FILENAME,
      content: soulContent,
    });

    const results = await Promise.all([
      loadWorkspaceBootstrapFiles(workspaceDir),
      loadWorkspaceBootstrapFiles(workspaceDir),
      loadWorkspaceBootstrapFiles(workspaceDir),
      loadWorkspaceBootstrapFiles(workspaceDir),
      loadWorkspaceBootstrapFiles(workspaceDir),
    ]);

    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0]);
    }

    expect(results[0].find((file) => file.name === DEFAULT_AGENTS_FILENAME)).toMatchObject({
      content: agentsContent,
      missing: false,
    });
    expect(results[0].find((file) => file.name === DEFAULT_SOUL_FILENAME)).toMatchObject({
      content: soulContent,
      missing: false,
    });
  });
});
