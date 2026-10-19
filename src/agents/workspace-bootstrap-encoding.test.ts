import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";
import { copyWorkspaceBootstrapFiles } from "./workspace-bootstrap-copy.js";
import { DEFAULT_AGENTS_FILENAME, DEFAULT_SOUL_FILENAME } from "./workspace-bootstrap-policy.js";
import { readWorkspaceFileWithGuards } from "./workspace-file-read.js";
import { loadWorkspaceBootstrapFiles } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// A critical rule followed by a lone 0xFF byte: invalid UTF-8 that a lossy
// decode silently renders as U+FFFD inside agent context.
const malformedBytes = Buffer.concat([
  Buffer.from("critical workspace rule\n"),
  Buffer.from([0xff]),
  Buffer.from("\n"),
]);

describe("workspace bootstrap file UTF-8 validation", () => {
  let workspaceDir: string;
  let releaseAccess: (() => void) | undefined;

  beforeEach(() => {
    workspaceDir = tempDirs.make("openclaw-bootstrap-encoding-test-");
    releaseAccess = undefined;
  });

  afterEach(() => {
    releaseAccess?.();
  });

  const agentsPath = (dir = workspaceDir) => path.join(dir, DEFAULT_AGENTS_FILENAME);

  it("routes malformed UTF-8 to the unreadable diagnostic instead of corrupted context", async () => {
    await fs.writeFile(agentsPath(), malformedBytes);
    const files = await loadWorkspaceBootstrapFiles(workspaceDir);
    const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
    expect(agents).toMatchObject({
      missing: false,
      content: "[UNREADABLE: Workspace bootstrap file is not valid UTF-8.]",
    });
  });

  it("classifies malformed UTF-8 as a validation failure in guarded reads", async () => {
    await fs.writeFile(agentsPath(), malformedBytes);
    const loaded = await readWorkspaceFileWithGuards({
      filePath: agentsPath(),
      workspaceDir,
    });
    expect(loaded).toMatchObject({ ok: false, reason: "validation" });
  });

  it("rejects malformed bridge bytes as validation failures", async () => {
    releaseAccess = registerAgentWorkspaceAccess(workspaceDir, {
      bridge: {
        readFile: async () => Buffer.alloc(0),
        writeFile: async () => undefined,
        stat: async () => null,
        readFileWithSource: async () => ({
          data: malformedBytes,
          canonicalPath: agentsPath(),
          workspaceRelativePath: DEFAULT_AGENTS_FILENAME,
        }),
      },
    });
    const loaded = await readWorkspaceFileWithGuards({
      filePath: agentsPath(),
      workspaceDir,
    });
    expect(loaded).toMatchObject({ ok: false, reason: "validation" });
  });

  it("skips undecodable sandbox seed files without copying corrupted content", async () => {
    const seedDir = tempDirs.make("openclaw-bootstrap-encoding-seed-");
    await fs.mkdir(seedDir, { recursive: true });
    await fs.writeFile(path.join(seedDir, DEFAULT_AGENTS_FILENAME), malformedBytes);
    await fs.writeFile(path.join(seedDir, DEFAULT_SOUL_FILENAME), "# valid soul\n");
    await copyWorkspaceBootstrapFiles(workspaceDir, seedDir, () => undefined);
    await expect(fs.stat(agentsPath())).rejects.toMatchObject({ code: "ENOENT" });
    const soul = await fs.readFile(path.join(workspaceDir, DEFAULT_SOUL_FILENAME), "utf8");
    expect(soul).toBe("# valid soul\n");
  });

  it("preserves valid BOM and multibyte content unchanged", async () => {
    const content = "\uFEFF# 引用 😀\ncritical workspace rule\n";
    await fs.writeFile(agentsPath(), content);
    const files = await loadWorkspaceBootstrapFiles(workspaceDir);
    const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
    expect(agents).toMatchObject({ missing: false, content });
  });
});
