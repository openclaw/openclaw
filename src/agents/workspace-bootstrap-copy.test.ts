import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { copyWorkspaceBootstrapFiles } from "./workspace-bootstrap-copy.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("copies supported identity avatar bytes while retaining the ordinary bootstrap bound", async () => {
  const root = tempDirs.make("bootstrap-avatar-copy-");
  const seed = path.join(root, "seed");
  const destination = path.join(root, "sandbox");
  await fs.mkdir(seed);
  const identity = `- Avatar: data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024).toString("base64")}\n- Name: Sandbox Identity\nInstructions after the avatar.\n`;
  await fs.writeFile(path.join(seed, "IDENTITY.md"), identity);
  await fs.writeFile(path.join(seed, "AGENTS.md"), "x".repeat(2 * 1024 * 1024 + 1));

  await copyWorkspaceBootstrapFiles(destination, seed, () => {});

  expect(await fs.readFile(path.join(destination, "IDENTITY.md"), "utf8")).toBe(identity);
  await expect(fs.stat(path.join(destination, "AGENTS.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await fs.readFile(path.join(seed, "IDENTITY.md"), "utf8")).toBe(identity);
});
