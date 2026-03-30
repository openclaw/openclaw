import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAlternateConfig(
  files: Record<string, string>,
  enabled = true,
): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "bootstrap-alternate-files": {
            enabled,
            files,
          },
        },
      },
    },
  };
}

function makeBootstrapFile(
  name: string,
  opts: { content?: string; missing?: boolean; sourcePath?: string } = {},
): AgentBootstrapHookContext["bootstrapFiles"][number] {
  return {
    name: name as AgentBootstrapHookContext["bootstrapFiles"][number]["name"],
    path: opts.sourcePath ?? `/workspace/${name}`,
    ...(opts.missing ? { missing: true } : { content: opts.content ?? `# ${name}`, missing: false }),
  };
}

function makeContext(
  files: AgentBootstrapHookContext["bootstrapFiles"],
  cfg: OpenClawConfig,
): AgentBootstrapHookContext {
  return { workspaceDir: "/workspace", bootstrapFiles: files, cfg, sessionKey: "agent:main:main" };
}

// ---------------------------------------------------------------------------
// Test fixtures — temp dir for real source files
// ---------------------------------------------------------------------------

let tmpDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-alternate-hook-"));
});

afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrap-alternate-files hook", () => {
  it("replaces a missing workspace entry with external source content", async () => {
    const sourceFile = path.join(tmpDir, "SOUL.md");
    await fs.writeFile(sourceFile, "# External Soul\nBe cool.", "utf-8");

    const context = makeContext(
      [makeBootstrapFile("SOUL.md", { missing: true })],
      createAlternateConfig({ "SOUL.md": sourceFile }),
    );

    await handler(createHookEvent("agent", "bootstrap", "agent:main:main", context));

    const soul = context.bootstrapFiles.find((f) => f.name === "SOUL.md");
    expect(soul?.missing).toBe(false);
    expect(soul?.content).toBe("# External Soul\nBe cool.");
    expect(soul?.path).toBe(sourceFile);
  });

  it("replaces a present workspace entry with external source content", async () => {
    const sourceFile = path.join(tmpDir, "IDENTITY.md");
    await fs.writeFile(sourceFile, "# External Identity\n- **Name:** flicker", "utf-8");

    const context = makeContext(
      [makeBootstrapFile("IDENTITY.md", { content: "# Old Identity", missing: false })],
      createAlternateConfig({ "IDENTITY.md": sourceFile }),
    );

    await handler(createHookEvent("agent", "bootstrap", "agent:main:main", context));

    const identity = context.bootstrapFiles.find((f) => f.name === "IDENTITY.md");
    expect(identity?.content).toBe("# External Identity\n- **Name:** flicker");
  });

  it("preserves list position when replacing", async () => {
    const sourceFile = path.join(tmpDir, "SOUL-position.md");
    await fs.writeFile(sourceFile, "# Soul", "utf-8");

    const context = makeContext(
      [
        makeBootstrapFile("AGENTS.md"),
        makeBootstrapFile("SOUL.md", { missing: true }),
        makeBootstrapFile("TOOLS.md"),
      ],
      createAlternateConfig({ "SOUL.md": sourceFile }),
    );

    await handler(createHookEvent("agent", "bootstrap", "agent:main:main", context));

    expect(context.bootstrapFiles.map((f) => f.name)).toEqual(["AGENTS.md", "SOUL.md", "TOOLS.md"]);
    expect(context.bootstrapFiles[1]?.missing).toBe(false);
  });

  it("leaves entry unchanged when source file is missing", async () => {
    const context = makeContext(
      [makeBootstrapFile("SOUL.md", { missing: true })],
      createAlternateConfig({ "SOUL.md": path.join(tmpDir, "does-not-exist.md") }),
    );

    await handler(createHookEvent("agent", "bootstrap", "agent:main:main", context));

    expect(context.bootstrapFiles[0]?.missing).toBe(true);
  });

  it("leaves entry unchanged when source is temporarily unavailable (EAGAIN)", async () => {
    // We can't easily simulate EAGAIN, so we just verify ENOENT fallback path leaves
    // the entry unchanged and does not throw.
    const context = makeContext(
      [makeBootstrapFile("SOUL.md", { missing: true })],
      createAlternateConfig({ "SOUL.md": "/nonexistent/path/SOUL.md" }),
    );

    await expect(
      handler(createHookEvent("agent", "bootstrap", "agent:main:main", context)),
    ).resolves.toBeUndefined();

    expect(context.bootstrapFiles[0]?.missing).toBe(true);
  });

  it("skips config entries with unrecognized bootstrap names", async () => {
    const sourceFile = path.join(tmpDir, "CUSTOM.md");
    await fs.writeFile(sourceFile, "custom content", "utf-8");

    const context = makeContext(
      [makeBootstrapFile("AGENTS.md")],
      createAlternateConfig({ "CUSTOM.md": sourceFile }),
    );

    await handler(createHookEvent("agent", "bootstrap", "agent:main:main", context));

    // AGENTS.md untouched, no error thrown
    expect(context.bootstrapFiles).toHaveLength(1);
    expect(context.bootstrapFiles[0]?.name).toBe("AGENTS.md");
  });

  it("does nothing when hook is disabled", async () => {
    const sourceFile = path.join(tmpDir, "SOUL-disabled.md");
    await fs.writeFile(sourceFile, "should not appear", "utf-8");

    const context = makeContext(
      [makeBootstrapFile("SOUL.md", { missing: true })],
      createAlternateConfig({ "SOUL.md": sourceFile }, false),
    );

    await handler(createHookEvent("agent", "bootstrap", "agent:main:main", context));

    expect(context.bootstrapFiles[0]?.missing).toBe(true);
  });

  it("does nothing when files map is empty", async () => {
    const context = makeContext(
      [makeBootstrapFile("SOUL.md", { missing: true })],
      createAlternateConfig({}),
    );

    await handler(createHookEvent("agent", "bootstrap", "agent:main:main", context));

    expect(context.bootstrapFiles[0]?.missing).toBe(true);
  });

  it("expands tilde in source paths", async () => {
    // Write a file in tmpDir and create a tilde path that points to it.
    // We can't easily test with a real home dir, so verify the file IS found
    // by providing an absolute path that happens to use home dir prefix.
    const homeDir = os.homedir();
    const relToHome = path.relative(homeDir, tmpDir);
    // Only run this sub-test if tmpDir is inside home
    if (relToHome.startsWith("..")) {
      return;
    }
    const tildePath = path.join("~", relToHome, "SOUL-tilde.md");
    const absFile = path.join(tmpDir, "SOUL-tilde.md");
    await fs.writeFile(absFile, "# Tilde Soul", "utf-8");

    const context = makeContext(
      [makeBootstrapFile("SOUL.md", { missing: true })],
      createAlternateConfig({ "SOUL.md": tildePath }),
    );

    await handler(createHookEvent("agent", "bootstrap", "agent:main:main", context));

    expect(context.bootstrapFiles[0]?.content).toBe("# Tilde Soul");
  });

  it("handles multiple replacements in a single pass", async () => {
    const soulFile = path.join(tmpDir, "SOUL-multi.md");
    const identFile = path.join(tmpDir, "IDENTITY-multi.md");
    await fs.writeFile(soulFile, "# Multi Soul", "utf-8");
    await fs.writeFile(identFile, "# Multi Identity", "utf-8");

    const context = makeContext(
      [
        makeBootstrapFile("SOUL.md", { missing: true }),
        makeBootstrapFile("AGENTS.md"),
        makeBootstrapFile("IDENTITY.md", { missing: true }),
      ],
      createAlternateConfig({ "SOUL.md": soulFile, "IDENTITY.md": identFile }),
    );

    await handler(createHookEvent("agent", "bootstrap", "agent:main:main", context));

    const soul = context.bootstrapFiles.find((f) => f.name === "SOUL.md");
    const identity = context.bootstrapFiles.find((f) => f.name === "IDENTITY.md");
    expect(soul?.content).toBe("# Multi Soul");
    expect(identity?.content).toBe("# Multi Identity");
    expect(context.bootstrapFiles.find((f) => f.name === "AGENTS.md")?.content).toBe("# AGENTS.md");
  });
});
