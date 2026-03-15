import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkPathGuardStrict } from "./path-guard.js";

describe("PathGuard Exhaustive Tests", () => {
  const workspaceRoot = "/workspace";
  const realWorkspaceRoot = "/real/workspace";
  const workspacePrefix = path.resolve(workspaceRoot).replace(/\\/g, "/");

  const mapWorkspacePath = (normalized: string): string => {
    if (normalized === workspacePrefix) {
      return realWorkspaceRoot;
    }
    if (normalized.startsWith(`${workspacePrefix}/`)) {
      return `${realWorkspaceRoot}${normalized.slice(workspacePrefix.length)}`;
    }
    return normalized;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(fs, "realpath").mockImplementation(async (input) => {
      const normalized = path.resolve(String(input)).replace(/\\/g, "/");
      if (normalized === path.resolve(workspaceRoot).replace(/\\/g, "/")) {
        return realWorkspaceRoot;
      }
      return mapWorkspacePath(normalized);
    });
  });

  it("allows access inside workspace when workspaceOnly is true", async () => {
    const requested = path.join(workspaceRoot, "src/index.ts");
    const resolved = path.join(realWorkspaceRoot, "src/index.ts");

    vi.spyOn(fs, "realpath").mockImplementation(async (input) => {
      const normalized = path.resolve(String(input)).replace(/\\/g, "/");
      if (normalized === path.resolve(workspaceRoot).replace(/\\/g, "/")) {
        return realWorkspaceRoot;
      }
      if (normalized === path.resolve(requested).replace(/\\/g, "/")) {
        return resolved;
      }
      return mapWorkspacePath(normalized);
    });

    const result = await checkPathGuardStrict(requested, { workspaceOnly: true }, workspaceRoot);
    expect(result).toBe(resolved);
  });

  it("denies access outside workspace when workspaceOnly is true", async () => {
    const requested = path.resolve(workspaceRoot, "..", "..", "outside.txt");
    await expect(
      checkPathGuardStrict(requested, { workspaceOnly: true }, workspaceRoot),
    ).rejects.toThrow();
  });

  it("denies access via chained symlinks escaping workspace", async () => {
    const linkA = path.join(workspaceRoot, "linkA");
    const linkB = path.join(workspaceRoot, "linkB");
    const target = "/etc/passwd";

    vi.spyOn(fs, "realpath").mockImplementation(async (input) => {
      const normalized = path.resolve(String(input)).replace(/\\/g, "/");
      if (normalized === path.resolve(workspaceRoot).replace(/\\/g, "/")) {
        return realWorkspaceRoot;
      }
      if (normalized === path.resolve(linkA).replace(/\\/g, "/")) {
        return linkB;
      }
      if (normalized === path.resolve(linkB).replace(/\\/g, "/")) {
        return target;
      }
      return mapWorkspacePath(normalized);
    });

    await expect(
      checkPathGuardStrict(linkA, { workspaceOnly: true }, workspaceRoot),
    ).rejects.toThrow(/outside the workspace root/);
  });

  it("denies access to a new file in a symlinked parent that escapes (multi-level)", async () => {
    const requested = path.join(workspaceRoot, "folder_link/new_file.txt");
    const externalDir = "/data/external";

    vi.spyOn(fs, "realpath").mockImplementation(async (input) => {
      const normalized = path.resolve(String(input)).replace(/\\/g, "/");
      if (normalized === path.resolve(workspaceRoot).replace(/\\/g, "/")) {
        return realWorkspaceRoot;
      }
      if (
        normalized === path.resolve(path.join(workspaceRoot, "folder_link")).replace(/\\/g, "/")
      ) {
        return externalDir;
      }
      if (normalized === path.resolve(requested).replace(/\\/g, "/")) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return mapWorkspacePath(normalized);
    });

    await expect(
      checkPathGuardStrict(requested, { workspaceOnly: true }, workspaceRoot),
    ).rejects.toThrow(/outside the workspace root/);
  });

  it("honors denyPaths with glob patterns (recursive and specific)", async () => {
    const configs = [
      { path: "src/config/secrets.json", pattern: "**/secrets.json" },
      { path: ".env", pattern: ".env" },
      { path: "node_modules/package/index.js", pattern: "node_modules/**" },
    ];

    for (const { path: reqPath, pattern } of configs) {
      const requested = path.join(workspaceRoot, reqPath);
      await expect(
        checkPathGuardStrict(requested, { denyPaths: [pattern] }, workspaceRoot),
      ).rejects.toThrow(/explicitly denied/);
    }
  });

  it("honors allowedPaths with complex glob patterns", async () => {
    const policy = { allowedPaths: ["src/**/*.{ts,tsx}", "public/**/*"] };

    await expect(
      checkPathGuardStrict(
        path.join(workspaceRoot, "src/components/Button.tsx"),
        policy,
        workspaceRoot,
      ),
    ).resolves.toBeDefined();
    await expect(
      checkPathGuardStrict(
        path.join(workspaceRoot, "public/assets/logo.png"),
        policy,
        workspaceRoot,
      ),
    ).resolves.toBeDefined();

    await expect(
      checkPathGuardStrict(path.join(workspaceRoot, "src/styles/main.css"), policy, workspaceRoot),
    ).rejects.toThrow(/not in the allowedPaths list/);
    await expect(
      checkPathGuardStrict(path.join(workspaceRoot, "package.json"), policy, workspaceRoot),
    ).rejects.toThrow(/not in the allowedPaths list/);
  });

  it("denies access if path is in both allowed and deny lists (precedence check)", async () => {
    const policy = {
      allowedPaths: ["src/**"],
      denyPaths: ["src/internal/**"],
    };

    await expect(
      checkPathGuardStrict(path.join(workspaceRoot, "src/index.ts"), policy, workspaceRoot),
    ).resolves.toBeDefined();
    await expect(
      checkPathGuardStrict(
        path.join(workspaceRoot, "src/internal/utils.ts"),
        policy,
        workspaceRoot,
      ),
    ).rejects.toThrow(/explicitly denied/);
  });

  it("handles paths with special characters and spaces", async () => {
    const requested = path.join(workspaceRoot, "my folder/data (v1).txt");
    const policy = { allowedPaths: ["my folder/**"] };

    await expect(checkPathGuardStrict(requested, policy, workspaceRoot)).resolves.toBeDefined();
  });

  it("does not allow outside paths via workspace-relative allow glob", async () => {
    const requested = path.resolve(workspaceRoot, "..", "outside.ts");
    const policy = { allowedPaths: ["**/*.ts"] };

    await expect(checkPathGuardStrict(requested, policy, workspaceRoot)).rejects.toThrow(
      /not in the allowedPaths list/,
    );
  });

  it("does not apply workspace-relative deny glob to outside paths", async () => {
    const requested = path.resolve(workspaceRoot, "..", "outside.ts");
    const policy = { denyPaths: ["**/*.ts"] };

    await expect(checkPathGuardStrict(requested, policy, workspaceRoot)).resolves.toBeDefined();
  });

  it("anchors non-glob relative policy entries to workspace root", async () => {
    const requested = path.resolve(workspaceRoot, "..", "shared", "note.txt");

    await expect(
      checkPathGuardStrict(requested, { allowedPaths: ["../shared"] }, workspaceRoot),
    ).rejects.toThrow(/not in the allowedPaths list/);
    await expect(
      checkPathGuardStrict(requested, { denyPaths: ["../shared"] }, workspaceRoot),
    ).resolves.toBeDefined();
  });

  it("detects brace and extglob patterns as globs", async () => {
    await expect(
      checkPathGuardStrict(
        path.join(workspaceRoot, ".env"),
        { denyPaths: ["{.env,.npmrc}"] },
        workspaceRoot,
      ),
    ).rejects.toThrow(/explicitly denied/);
    await expect(
      checkPathGuardStrict(
        path.join(workspaceRoot, "src", "index.ts"),
        { allowedPaths: ["+(src|lib)/**"] },
        workspaceRoot,
      ),
    ).resolves.toBeDefined();
  });

  it("resolves paths correctly even if they contain redundant separators or dots", async () => {
    const requested = path.join(workspaceRoot, "src/../src/./index.ts");
    const resolved = path.join(realWorkspaceRoot, "src/index.ts");

    vi.spyOn(fs, "realpath").mockImplementation(async (input) => {
      const normalized = path.resolve(String(input)).replace(/\\/g, "/");
      if (normalized === path.resolve(workspaceRoot).replace(/\\/g, "/")) {
        return realWorkspaceRoot;
      }
      if (normalized === path.resolve(workspaceRoot, "src/index.ts").replace(/\\/g, "/")) {
        return resolved;
      }
      return mapWorkspacePath(normalized);
    });

    const result = await checkPathGuardStrict(requested, { workspaceOnly: true }, workspaceRoot);
    expect(result).toBe(resolved);
  });
});
