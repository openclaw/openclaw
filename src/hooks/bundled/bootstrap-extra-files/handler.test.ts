import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

function createBootstrapExtraConfig(paths: string[]): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "bootstrap-extra-files": {
            enabled: true,
            paths,
          },
        },
      },
    },
  };
}

async function createBootstrapContext(params: {
  workspaceDir: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  rootFiles: Array<{ name: string; content: string }>;
}): Promise<AgentBootstrapHookContext> {
  const bootstrapFiles = (await Promise.all(
    params.rootFiles.map(async (file) => ({
      name: file.name,
      path: await writeWorkspaceFile({
        dir: params.workspaceDir,
        name: file.name,
        content: file.content,
      }),
      content: file.content,
      missing: false,
    })),
  )) as AgentBootstrapHookContext["bootstrapFiles"];
  return {
    workspaceDir: params.workspaceDir,
    bootstrapFiles,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  };
}

describe("bootstrap-extra-files hook", () => {
  it("appends extra bootstrap files from configured patterns under full tier", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-");
    const extraDir = path.join(tempDir, "packages", "core");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "AGENTS.md"), "extra agents", "utf-8");

    const cfg: OpenClawConfig = {
      ...createBootstrapExtraConfig(["packages/*/AGENTS.md"]),
      agents: { defaults: { bootstrapTier: "full" } },
    };
    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:main",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    const injected = context.bootstrapFiles.filter((f) => f.name === "AGENTS.md");
    expect(injected).toHaveLength(2);
    expect(injected.some((f) => f.path.endsWith(path.join("packages", "core", "AGENTS.md")))).toBe(
      true,
    );
  });

  it("excludes hook-loaded extras under standard tier even when basename matches root allowlist", async () => {
    // Regression: previously the standard-tier filter matched only on basename,
    // so a hook-loaded `packages/core/AGENTS.md` would pass through alongside
    // the root AGENTS.md, making `standard` indistinguishable from `full` on the
    // real hook path. Hook-sourced files must be excluded under `standard`.
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-standard-");
    const extraDir = path.join(tempDir, "packages", "core");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "AGENTS.md"), "extra agents", "utf-8");

    const cfg: OpenClawConfig = {
      ...createBootstrapExtraConfig(["packages/*/AGENTS.md"]),
      agents: { defaults: { bootstrapTier: "standard" } },
    };
    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:main",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    const agentsEntries = context.bootstrapFiles.filter((f) => f.name === "AGENTS.md");
    expect(agentsEntries).toHaveLength(1);
    expect(
      agentsEntries.some((f) => f.path.endsWith(path.join("packages", "core", "AGENTS.md"))),
    ).toBe(false);
    expect(agentsEntries[0]?.path.endsWith(path.join(tempDir, "AGENTS.md"))).toBe(true);
  });

  it("includes hook-loaded extras under full tier", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-full-");
    const extraDir = path.join(tempDir, "packages", "core");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "AGENTS.md"), "extra agents", "utf-8");

    const cfg: OpenClawConfig = {
      ...createBootstrapExtraConfig(["packages/*/AGENTS.md"]),
      agents: { defaults: { bootstrapTier: "full" } },
    };
    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:main",
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    const agentsEntries = context.bootstrapFiles.filter((f) => f.name === "AGENTS.md");
    expect(agentsEntries).toHaveLength(2);
    expect(
      agentsEntries.some((f) => f.path.endsWith(path.join("packages", "core", "AGENTS.md"))),
    ).toBe(true);
  });

  it("re-applies subagent bootstrap allowlist after extras are added", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-subagent-");
    const extraDir = path.join(tempDir, "packages", "persona");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "SOUL.md"), "evil", "utf-8");

    const cfg = createBootstrapExtraConfig(["packages/*/SOUL.md"]);
    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: "agent:main:subagent:abc",
      rootFiles: [
        { name: "AGENTS.md", content: "root agents" },
        { name: "TOOLS.md", content: "root tools" },
      ],
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:subagent:abc", context);
    await handler(event);
    expect(context.bootstrapFiles.map((f) => f.name).toSorted()).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
    ]);
  });
});
