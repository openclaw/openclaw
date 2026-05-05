import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

function createBootstrapExtraConfig(params: {
  paths?: string[];
  sessions?: Record<string, string[]>;
}): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "bootstrap-extra-files": {
            enabled: true,
            paths: params.paths,
            sessions: params.sessions,
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
  it("appends extra bootstrap files from configured patterns", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-");
    const extraDir = path.join(tempDir, "packages", "core");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "AGENTS.md"), "extra agents", "utf-8");

    const cfg = createBootstrapExtraConfig({ paths: ["packages/*/AGENTS.md"] });
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

  it("re-applies subagent bootstrap allowlist after extras are added", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-subagent-");
    const extraDir = path.join(tempDir, "packages", "persona");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "SOUL.md"), "evil", "utf-8");

    const cfg = createBootstrapExtraConfig({ paths: ["packages/*/SOUL.md"] });
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

  it("adds session-specific bootstrap files only for the exact session key", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-session-");
    const sessionDir = path.join(tempDir, "sessions", "zeus-dev");
    const otherDir = path.join(tempDir, "sessions", "main");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "BOOTSTRAP-ZEUS.md"), "zeus bootstrap", "utf-8");
    await fs.writeFile(path.join(otherDir, "BOOTSTRAP-MAIN.md"), "main bootstrap", "utf-8");

    const sessionKey = "agent:main:whatsapp:group:123";
    const cfg = createBootstrapExtraConfig({
      sessions: {
        [sessionKey]: ["sessions/zeus-dev/BOOTSTRAP-ZEUS.md"],
        "agent:main:whatsapp:group:456": ["sessions/main/BOOTSTRAP-MAIN.md"],
      },
    });
    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey,
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", sessionKey, context);
    await handler(event);

    expect(context.bootstrapFiles.map((file) => file.content)).toContain("zeus bootstrap");
    expect(context.bootstrapFiles.map((file) => file.content)).not.toContain("main bootstrap");
  });

  it("keeps arbitrary basenames scoped to matching session entries", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-session-custom-");
    const sessionDir = path.join(tempDir, "sessions", "zeus-dev");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "ZEUS.md"), "zeus custom", "utf-8");

    const sessionKey = "agent:main:whatsapp:group:123";
    const cfg = createBootstrapExtraConfig({
      paths: ["sessions/zeus-dev/ZEUS.md"],
      sessions: {
        [sessionKey]: ["sessions/zeus-dev/ZEUS.md"],
      },
    });
    const nonMatchingSessionKey = "agent:main:whatsapp:group:456";
    const nonMatchingContext = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey: nonMatchingSessionKey,
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });
    const matchingContext = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey,
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const nonMatchingEvent = createHookEvent(
      "agent",
      "bootstrap",
      nonMatchingSessionKey,
      nonMatchingContext,
    );
    const matchingEvent = createHookEvent("agent", "bootstrap", sessionKey, matchingContext);
    await handler(nonMatchingEvent);
    await handler(matchingEvent);

    expect(nonMatchingContext.bootstrapFiles.map((file) => file.content)).not.toContain(
      "zeus custom",
    );
    expect(matchingContext.bootstrapFiles.map((file) => file.content)).toContain("zeus custom");
  });

  it("combines and deduplicates global and session-specific patterns", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-session-dedupe-");
    const sessionDir = path.join(tempDir, "sessions", "zeus-dev");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "BOOTSTRAP-ZEUS.md"), "zeus bootstrap", "utf-8");
    await fs.writeFile(path.join(sessionDir, "TOOLS.md"), "zeus tools", "utf-8");

    const sessionKey = "agent:main:whatsapp:group:123";
    const cfg = createBootstrapExtraConfig({
      paths: ["sessions/zeus-dev/BOOTSTRAP-ZEUS.md"],
      sessions: {
        [sessionKey]: ["sessions/zeus-dev/BOOTSTRAP-ZEUS.md", "sessions/zeus-dev/TOOLS.md"],
      },
    });
    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey,
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", sessionKey, context);
    await handler(event);

    expect(context.bootstrapFiles.map((file) => file.content)).toEqual([
      "root agents",
      "zeus bootstrap",
      "zeus tools",
    ]);
    expect(context.bootstrapFiles.filter((file) => file.content === "zeus bootstrap")).toHaveLength(
      1,
    );
  });

  it("keeps session-specific paths inside the workspace boundary", async () => {
    const tempDir = await makeTempWorkspace("openclaw-bootstrap-extra-session-boundary-");
    const outsideDir = path.join(path.dirname(tempDir), `${path.basename(tempDir)}-outside`);
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "BOOTSTRAP.md"), "outside bootstrap", "utf-8");

    const sessionKey = "agent:main:whatsapp:group:123";
    const cfg = createBootstrapExtraConfig({
      sessions: {
        [sessionKey]: [path.relative(tempDir, path.join(outsideDir, "BOOTSTRAP.md"))],
      },
    });
    const context = await createBootstrapContext({
      workspaceDir: tempDir,
      cfg,
      sessionKey,
      rootFiles: [{ name: "AGENTS.md", content: "root agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", sessionKey, context);
    await handler(event);

    expect(context.bootstrapFiles.map((file) => file.content)).not.toContain("outside bootstrap");
  });
});
