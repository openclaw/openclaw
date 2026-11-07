import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";
import * as workspaceBootstrapRead from "./workspace-bootstrap-read.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "./workspace-bootstrap-read.js";
import { readWorkspaceFileWithGuards } from "./workspace-file-read.js";
import {
  loadExtraBootstrapFilesWithDiagnostics,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("identity avatar model projection", () => {
  it.each(["local", "managed"] as const)(
    "keeps supported inline avatars out of prompt identity without changing %s source bytes",
    async (kind) => {
      const workspace = tempDirs.make("identity-avatar-prompt-");
      const filePath = path.join(workspace, "IDENTITY.md");
      const avatar = `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024).toString("base64")}`;
      const source = `# Identity\r\nBefore avatar instructions.\r\n- **aVaTaR:** \`${avatar}\`\r\n- Name: Small Identity\r\n- Creature: Familiar\r\nAfter avatar instructions.\r\n`;
      await fs.writeFile(filePath, source);
      const release =
        kind === "managed"
          ? registerAgentWorkspaceAccess(workspace, {
              bridge: {
                stat: vi.fn(),
                writeFile: vi.fn(),
                readFile: async () => Buffer.from(source),
                readFileWithSource: async ({ maxBytes }) => {
                  if (Buffer.byteLength(source) > (maxBytes ?? Infinity)) {
                    throw new RangeError("Remote document exceeds its read bound");
                  }
                  return { data: Buffer.from(source), canonicalPath: filePath };
                },
              },
            })
          : () => {};
      const project = vi.spyOn(workspaceBootstrapRead, "projectWorkspaceBootstrapFileForPrompt");
      try {
        const [identity] = await loadWorkspaceBootstrapFiles(workspace, ["IDENTITY.md"]);
        expect(identity?.content).not.toContain("[UNREADABLE:");
        expect(identity?.content).toBe(
          source.replace(`- **aVaTaR:** \`${avatar}\``, "- Avatar: [inline image omitted]"),
        );
        const raw = await readWorkspaceFileWithGuards({ filePath, workspaceDir: workspace });
        expect(raw).toMatchObject({ ok: true, content: source });
        const extra = await loadExtraBootstrapFilesWithDiagnostics(workspace, ["IDENTITY.md"]);
        expect(extra.files[0]?.content).toBe(identity?.content);
        expect(extra.diagnostics).toEqual([]);
        expect(project).toHaveBeenCalledTimes(kind === "local" ? 1 : 2);
        expect(await fs.readFile(filePath, "utf8")).toBe(source);
      } finally {
        project.mockRestore();
        release();
      }
    },
  );

  it.each(["https://example.test/avatar.png", "portraits/agent.png"])(
    "preserves ordinary identity bytes for a non-inline avatar (%s)",
    async (avatar) => {
      const workspace = tempDirs.make("identity-text-avatar-");
      const source = `# Identity\r\n- **Avatar:** ${avatar}\r\n- Name: Unchanged\r\nCustom instructions.\r\n`;
      await fs.writeFile(path.join(workspace, "IDENTITY.md"), source);
      const [identity] = await loadWorkspaceBootstrapFiles(workspace, ["IDENTITY.md"]);
      expect(identity?.content).toBe(source);
    },
  );

  it("retains the prompt text bound when an avatar-bearing identity also has oversized prose", async () => {
    const workspace = tempDirs.make("identity-avatar-prose-bound-");
    const source = `- Avatar: data:image/png;base64,YQ==\n${"x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES)}`;
    await fs.writeFile(path.join(workspace, "IDENTITY.md"), source);
    const [identity] = await loadWorkspaceBootstrapFiles(workspace, ["IDENTITY.md"]);
    expect(identity?.content).toContain("[UNREADABLE:");
    expect(await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8")).toBe(source);
  });

  it("keeps an ordinary file alias bounded after caching the larger raw identity", async () => {
    if (process.platform === "win32") {
      return;
    }
    const workspace = tempDirs.make("identity-avatar-cache-bound-");
    const identityPath = path.join(workspace, "IDENTITY.md");
    const source = `- Avatar: data:image/png;base64,${"A".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES)}\n- Name: Cached\n`;
    await fs.writeFile(identityPath, source);
    const raw = await readWorkspaceFileWithGuards({
      filePath: identityPath,
      workspaceDir: workspace,
    });
    expect(raw).toMatchObject({ ok: true, content: source });
    await fs.symlink("IDENTITY.md", path.join(workspace, "AGENTS.md"));

    const [agents] = await loadWorkspaceBootstrapFiles(workspace, ["AGENTS.md"]);
    expect(agents?.content).toContain("[UNREADABLE:");
    expect(await fs.readFile(identityPath, "utf8")).toBe(source);
  });
});
