import JSZip from "jszip";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterAll, describe, expect, it, vi } from "vitest";

const fixtureRoot = path.join(os.tmpdir(), `openclaw-hook-install-${randomUUID()}`);
let tempDirIndex = 0;

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const { runCommandWithTimeout } = await import("../process/exec.js");
const { installHooksFromArchive, installHooksFromPath } = await import("./install.js");

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

describe("installHooksFromArchive", () => {
  it("installs hook packs from zip archives", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "hooks.zip");

    const zip = new JSZip();
    zip.file(
      "package/package.json",
      JSON.stringify({
        name: "@openclaw/zip-hooks",
        version: "0.0.1",
        openclaw: { hooks: ["./hooks/zip-hook"] },
      }),
    );
    zip.file(
      "package/hooks/zip-hook/HOOK.md",
      [
        "---",
        "name: zip-hook",
        "description: Zip hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# Zip Hook",
      ].join("\n"),
    );
    zip.file("package/hooks/zip-hook/handler.ts", "export default async () => {};\n");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    fs.writeFileSync(archivePath, buffer);

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("zip-hooks");
    expect(result.hooks).toContain("zip-hook");
    expect(result.targetDir).toBe(path.join(stateDir, "hooks", "zip-hooks"));
    expect(fs.existsSync(path.join(result.targetDir, "hooks", "zip-hook", "HOOK.md"))).toBe(true);
  });

  it("installs hook packs from tar archives", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "hooks.tar");
    const pkgDir = path.join(workDir, "package");

    fs.mkdirSync(path.join(pkgDir, "hooks", "tar-hook"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/tar-hooks",
        version: "0.0.1",
        openclaw: { hooks: ["./hooks/tar-hook"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "tar-hook", "HOOK.md"),
      [
        "---",
        "name: tar-hook",
        "description: Tar hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# Tar Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "tar-hook", "handler.ts"),
      "export default async () => {};\n",
      "utf-8",
    );
    await tar.c({ cwd: workDir, file: archivePath }, ["package"]);

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("tar-hooks");
    expect(result.hooks).toContain("tar-hook");
    expect(result.targetDir).toBe(path.join(stateDir, "hooks", "tar-hooks"));
  });

  it("rejects hook packs with traversal-like ids", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "hooks.tar");
    const pkgDir = path.join(workDir, "package");

    fs.mkdirSync(path.join(pkgDir, "hooks", "evil-hook"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@evil/..",
        version: "0.0.1",
        openclaw: { hooks: ["./hooks/evil-hook"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "evil-hook", "HOOK.md"),
      [
        "---",
        "name: evil-hook",
        "description: Evil hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# Evil Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "evil-hook", "handler.ts"),
      "export default async () => {};\n",
      "utf-8",
    );
    await tar.c({ cwd: workDir, file: archivePath }, ["package"]);

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("reserved path segment");
  });

  it("rejects hook packs with reserved ids", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const archivePath = path.join(workDir, "hooks.tar");
    const pkgDir = path.join(workDir, "package");

    fs.mkdirSync(path.join(pkgDir, "hooks", "reserved-hook"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@evil/.",
        version: "0.0.1",
        openclaw: { hooks: ["./hooks/reserved-hook"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "reserved-hook", "HOOK.md"),
      [
        "---",
        "name: reserved-hook",
        "description: Reserved hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# Reserved Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "reserved-hook", "handler.ts"),
      "export default async () => {};\n",
      "utf-8",
    );
    await tar.c({ cwd: workDir, file: archivePath }, ["package"]);

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromArchive({ archivePath, hooksDir });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("reserved path segment");
  });
});

describe("installHooksFromPath", () => {
  it("uses --ignore-scripts for dependency install", async () => {
    const workDir = makeTempDir();
    const stateDir = makeTempDir();
    const pkgDir = path.join(workDir, "package");
    fs.mkdirSync(path.join(pkgDir, "hooks", "one-hook"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/test-hooks",
        version: "0.0.1",
        openclaw: { hooks: ["./hooks/one-hook"] },
        dependencies: { "left-pad": "1.3.0" },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "one-hook", "HOOK.md"),
      [
        "---",
        "name: one-hook",
        "description: One hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# One Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pkgDir, "hooks", "one-hook", "handler.ts"),
      "export default async () => {};\n",
      "utf-8",
    );

    const run = vi.mocked(runCommandWithTimeout);
    run.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const res = await installHooksFromPath({
      path: pkgDir,
      hooksDir: path.join(stateDir, "hooks"),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }

    const calls = run.mock.calls.filter((c) => Array.isArray(c[0]) && c[0][0] === "npm");
    expect(calls.length).toBe(1);
    const first = calls[0];
    if (!first) {
      throw new Error("expected npm install call");
    }
    const [argv, opts] = first;
    expect(argv).toEqual(["npm", "install", "--omit=dev", "--silent", "--ignore-scripts"]);
    expect(opts?.cwd).toBe(res.targetDir);
  });
});

describe("installHooksFromPath", () => {
  it("installs a single hook directory", async () => {
    const stateDir = makeTempDir();
    const workDir = makeTempDir();
    const hookDir = path.join(workDir, "my-hook");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(
      path.join(hookDir, "HOOK.md"),
      [
        "---",
        "name: my-hook",
        "description: My hook",
        'metadata: {"openclaw":{"events":["command:new"]}}',
        "---",
        "",
        "# My Hook",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromPath({ path: hookDir, hooksDir });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("my-hook");
    expect(result.hooks).toEqual(["my-hook"]);
    expect(result.targetDir).toBe(path.join(stateDir, "hooks", "my-hook"));
    expect(fs.existsSync(path.join(result.targetDir, "HOOK.md"))).toBe(true);
  });
});
