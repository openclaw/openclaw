import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertToolWritePathAllowed,
  normalizeToolWritePathPolicy,
} from "./tool-write-path-policy.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-path-policy-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("normalizeToolWritePathPolicy", () => {
  it("trims and dedupes allow/deny patterns", () => {
    expect(
      normalizeToolWritePathPolicy({
        allow: [" notes/** ", "notes/**", ""],
        deny: [" private/** ", "private/**", " "],
      }),
    ).toEqual({
      allow: ["notes/**"],
      deny: ["private/**"],
    });
  });
});

describe("assertToolWritePathAllowed", () => {
  it("allows writes that match allow patterns", async () => {
    await withTempDir(async (workspaceRoot) => {
      await fs.mkdir(path.join(workspaceRoot, "notes"), { recursive: true });
      const targetPath = path.join(workspaceRoot, "notes", "ok.txt");
      expect(() =>
        assertToolWritePathAllowed({
          policy: { allow: ["notes/**"] },
          workspaceRoot,
          candidatePath: targetPath,
          cwd: workspaceRoot,
        }),
      ).not.toThrow();
    });
  });

  it("rejects write paths that traverse symlinked directories outside allow patterns", async () => {
    await withTempDir(async (workspaceRoot) => {
      const notesDir = path.join(workspaceRoot, "notes");
      const privateDir = path.join(workspaceRoot, "private");
      await fs.mkdir(notesDir, { recursive: true });
      await fs.mkdir(privateDir, { recursive: true });
      await fs.symlink(
        privateDir,
        path.join(notesDir, "linkdir"),
        process.platform === "win32" ? "junction" : undefined,
      );

      const candidatePath = path.join(notesDir, "linkdir", "new.txt");
      expect(() =>
        assertToolWritePathAllowed({
          policy: { allow: ["notes/**"] },
          workspaceRoot,
          candidatePath,
          cwd: workspaceRoot,
        }),
      ).toThrow(/not allowed by cron payload\.paths\.allow/i);
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects existing symlink file targets outside allow patterns",
    async () => {
      await withTempDir(async (workspaceRoot) => {
        const notesDir = path.join(workspaceRoot, "notes");
        const privateDir = path.join(workspaceRoot, "private");
        await fs.mkdir(notesDir, { recursive: true });
        await fs.mkdir(privateDir, { recursive: true });
        const privateFile = path.join(privateDir, "secret.txt");
        await fs.writeFile(privateFile, "secret", "utf8");
        const linkPath = path.join(notesDir, "secret-link.txt");
        await fs.symlink(privateFile, linkPath);

        expect(() =>
          assertToolWritePathAllowed({
            policy: { allow: ["notes/**"] },
            workspaceRoot,
            candidatePath: linkPath,
            cwd: workspaceRoot,
          }),
        ).toThrow(/not allowed by cron payload\.paths\.allow/i);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects hardlinked files because target identity is ambiguous",
    async () => {
      await withTempDir(async (workspaceRoot) => {
        const notesDir = path.join(workspaceRoot, "notes");
        const privateDir = path.join(workspaceRoot, "private");
        await fs.mkdir(notesDir, { recursive: true });
        await fs.mkdir(privateDir, { recursive: true });

        const privateFile = path.join(privateDir, "secret.txt");
        const aliasPath = path.join(notesDir, "hardlink.txt");
        await fs.writeFile(privateFile, "secret", "utf8");
        try {
          await fs.link(privateFile, aliasPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EXDEV") {
            return;
          }
          throw error;
        }

        expect(() =>
          assertToolWritePathAllowed({
            policy: { allow: ["notes/**"] },
            workspaceRoot,
            candidatePath: aliasPath,
            cwd: workspaceRoot,
          }),
        ).toThrow(/hardlinked file/i);
      });
    },
  );
});
