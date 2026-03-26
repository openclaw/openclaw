import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_CLAUDE_FILENAME,
  DEFAULT_OPENCLAW_FILENAME,
  discoverWorkspacePolicyFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

describe("discoverWorkspacePolicyFiles", () => {
  it("reports injected bootstrap files and candidate policy markdown files", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-discovery-"));
    try {
      await fs.writeFile(path.join(workspaceDir, DEFAULT_AGENTS_FILENAME), "agents", "utf-8");
      await fs.writeFile(path.join(workspaceDir, DEFAULT_CLAUDE_FILENAME), "claude", "utf-8");
      await fs.writeFile(path.join(workspaceDir, DEFAULT_OPENCLAW_FILENAME), "focus", "utf-8");
      await fs.writeFile(path.join(workspaceDir, "standing-orders.md"), "orders", "utf-8");
      await fs.mkdir(path.join(workspaceDir, "docs"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "docs", "workflow.md"), "flow", "utf-8");
      await fs.writeFile(path.join(workspaceDir, "README.md"), "ignore", "utf-8");

      const bootstrapFiles: WorkspaceBootstrapFile[] = [
        {
          name: DEFAULT_AGENTS_FILENAME,
          path: path.join(workspaceDir, DEFAULT_AGENTS_FILENAME),
          content: "agents",
          missing: false,
        },
        {
          name: DEFAULT_CLAUDE_FILENAME,
          path: path.join(workspaceDir, DEFAULT_CLAUDE_FILENAME),
          content: "claude",
          missing: false,
        },
        {
          name: DEFAULT_OPENCLAW_FILENAME,
          path: path.join(workspaceDir, DEFAULT_OPENCLAW_FILENAME),
          content: "focus",
          missing: false,
        },
      ];

      const files = discoverWorkspacePolicyFiles({ dir: workspaceDir, bootstrapFiles });
      expect(
        files.map((file) => ({
          name: file.name,
          kind: file.kind,
          autoInjected: file.autoInjected,
          mergeTier: file.mergeTier,
          source: file.source,
          conflictSummary: file.conflictSummary,
        })),
      ).toEqual([
        {
          name: "AGENTS.md",
          kind: "bootstrap",
          autoInjected: true,
          mergeTier: "primary",
          source: "workspace-root",
          conflictSummary: "shares global-guidance role with CLAUDE.md",
        },
        {
          name: "CLAUDE.md",
          kind: "bootstrap",
          autoInjected: true,
          mergeTier: "primary",
          source: "workspace-root",
          conflictSummary: "shares global-guidance role with AGENTS.md",
        },
        {
          name: "OPENCLAW.md",
          kind: "bootstrap",
          autoInjected: true,
          mergeTier: "primary",
          source: "workspace-root",
          conflictSummary: undefined,
        },
        {
          name: "workflow.md",
          kind: "candidate",
          autoInjected: false,
          mergeTier: "candidate",
          source: "policy-scan",
          conflictSummary: undefined,
        },
        {
          name: "standing-orders.md",
          kind: "candidate",
          autoInjected: false,
          mergeTier: "candidate",
          source: "policy-scan",
          conflictSummary: undefined,
        },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
