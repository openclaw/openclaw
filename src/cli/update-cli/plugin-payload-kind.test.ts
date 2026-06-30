import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePluginInstallPayloadKind } from "./plugin-payload-kind.js";

describe("resolvePluginInstallPayloadKind", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-payload-kind-"));
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns 'bundle' for a codex bundle layout", async () => {
    const dir = path.join(tmpRoot, "codex-plugin");
    await fs.mkdir(path.join(dir, ".codex-plugin"), { recursive: true });
    await fs.writeFile(path.join(dir, ".codex-plugin", "plugin.json"), "{}", "utf8");
    expect(resolvePluginInstallPayloadKind(dir)).toBe("bundle");
  });

  it("returns 'bundle' for a claude bundle layout", async () => {
    const dir = path.join(tmpRoot, "claude-plugin");
    await fs.mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
    await fs.writeFile(path.join(dir, ".claude-plugin", "plugin.json"), "{}", "utf8");
    expect(resolvePluginInstallPayloadKind(dir)).toBe("bundle");
  });

  it("returns 'bundle' for a cursor bundle layout", async () => {
    const dir = path.join(tmpRoot, "cursor-plugin");
    await fs.mkdir(path.join(dir, ".cursor-plugin"), { recursive: true });
    await fs.writeFile(path.join(dir, ".cursor-plugin", "plugin.json"), "{}", "utf8");
    expect(resolvePluginInstallPayloadKind(dir)).toBe("bundle");
  });

  it("returns 'bundle' for a manifestless claude layout", async () => {
    const dir = path.join(tmpRoot, "manifestless-claude");
    await fs.mkdir(path.join(dir, "skills"), { recursive: true });
    await fs.writeFile(path.join(dir, "skills", "SKILL.md"), "---\n", "utf8");
    expect(resolvePluginInstallPayloadKind(dir)).toBe("bundle");
  });

  it("returns 'npm-package' when package.json exists", async () => {
    const dir = path.join(tmpRoot, "npm-plugin");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), '{"name":"@openclaw/npm"}', "utf8");
    expect(resolvePluginInstallPayloadKind(dir)).toBe("npm-package");
  });

  it("returns 'unknown' for an empty directory", async () => {
    const dir = path.join(tmpRoot, "empty");
    await fs.mkdir(dir, { recursive: true });
    expect(resolvePluginInstallPayloadKind(dir)).toBe("unknown");
  });

  it("prefers bundle when both bundle manifest and package.json exist", async () => {
    const dir = path.join(tmpRoot, "dual");
    await fs.mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
    await fs.writeFile(path.join(dir, ".claude-plugin", "plugin.json"), "{}", "utf8");
    await fs.writeFile(path.join(dir, "package.json"), '{"name":"@openclaw/dual"}', "utf8");
    expect(resolvePluginInstallPayloadKind(dir)).toBe("bundle");
  });
});
