import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGuardian, GuardianDeniedError } from "./guardian.js";

describe("guardian", () => {
  it("matches first rule and respects prefix boundaries", async () => {
    const dir = makeTempDir();
    try {
      const protectedRoot = path.join(dir, "protected");
      const allowedRoot = path.join(protectedRoot, "allowed");
      const target = path.join(allowedRoot, "file.txt");

      const guardian = createGuardian({
        enabled: true,
        rules: [
          { mode: "deny", path: protectedRoot },
          { mode: "public", path: allowedRoot },
        ],
      });

      const result = await guardian.checkAction({
        actionType: "write",
        targetPath: target,
      });

      expect(result.allowed).toBe(false);
      expect(result.mode).toBe("deny");

      const boundaryGuardian = createGuardian({
        enabled: true,
        rules: [{ mode: "deny", path: path.join(dir, "app") }],
      });

      const boundaryResult = await boundaryGuardian.checkAction({
        actionType: "write",
        targetPath: path.join(dir, "appetizer", "file.txt"),
      });

      expect(boundaryResult.allowed).toBe(true);
      expect(boundaryResult.mode).toBe("public");
    } finally {
      cleanupDir(dir);
    }
  });

  it("allows when a key file exists in an ancestor directory", async () => {
    const dir = makeTempDir();
    try {
      const root = path.join(dir, "repo");
      const nested = path.join(root, "src", "lib");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(root, ".openclaw.key"), "ok");

      const guardian = createGuardian({
        enabled: true,
        rules: [{ mode: "needs_key", path: root }],
      });

      const result = await guardian.checkAction({
        actionType: "write",
        targetPath: path.join(nested, "file.txt"),
      });

      expect(result.allowed).toBe(true);
      expect(result.mode).toBe("needs_key");
      expect(result.reason).toBe("key=present");
    } finally {
      cleanupDir(dir);
    }
  });

  it("denies when key files are missing", async () => {
    const dir = makeTempDir();
    try {
      const root = path.join(dir, "repo");
      const nested = path.join(root, "docs");
      fs.mkdirSync(nested, { recursive: true });

      const guardian = createGuardian({
        enabled: true,
        rules: [{ mode: "needs_key", path: root }],
      });

      const result = await guardian.checkAction({
        actionType: "write",
        targetPath: path.join(nested, "file.txt"),
      });

      expect(result.allowed).toBe(false);
      expect(result.mode).toBe("needs_key");
      expect(result.reason).toBe("key=missing");
    } finally {
      cleanupDir(dir);
    }
  });

  it("expires cached key results after ttl", async () => {
    const dir = makeTempDir();
    try {
      const root = path.join(dir, "repo");
      fs.mkdirSync(root, { recursive: true });

      let now = 0;
      const guardian = createGuardian(
        {
          enabled: true,
          cacheTtlMs: 10,
          rules: [{ mode: "needs_key", path: root }],
        },
        { now: () => now, maxKeyLookupDepth: 1 },
      );

      const targetPath = path.join(root, "file.txt");

      const first = await guardian.checkAction({
        actionType: "write",
        targetPath,
      });

      expect(first.allowed).toBe(false);

      fs.writeFileSync(path.join(root, ".openclaw.key"), "ok");

      now = 5;
      const cached = await guardian.checkAction({
        actionType: "write",
        targetPath,
      });

      expect(cached.allowed).toBe(false);

      now = 15;
      const refreshed = await guardian.checkAction({
        actionType: "write",
        targetPath,
      });

      expect(refreshed.allowed).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });

  it("returns deny and error details for blocked rules", async () => {
    const dir = makeTempDir();
    try {
      const root = path.join(dir, "blocked");
      const guardian = createGuardian({
        enabled: true,
        rules: [{ mode: "deny", path: root }],
      });

      const targetPath = path.join(root, "file.txt");
      const result = await guardian.checkAction({
        actionType: "delete",
        targetPath,
      });

      expect(result.allowed).toBe(false);
      expect(result.mode).toBe("deny");
      expect(result.reason).toBe("rule=deny");

      const err = new GuardianDeniedError("delete", targetPath);
      expect(err.message).toContain("delete");
      expect(err.message).toContain(targetPath);
    } finally {
      cleanupDir(dir);
    }
  });
});

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `openclaw-guardian-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
