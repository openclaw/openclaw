import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  buildAgentWorkspaceArtifactPath,
  buildRandomTempFilePath,
  resolveAgentWorkspaceOutputPath,
  withTempDownloadPath,
} from "./temp-path.js";

const cfg = {
  agents: {
    defaults: {
      workspace: "/Users/admin/.openclaw/workspace",
    },
    list: [
      {
        id: "ops",
        workspace: "/Users/admin/.openclaw/workspace-ops",
      },
    ],
  },
};

describe("buildRandomTempFilePath", () => {
  it("builds deterministic paths when now/uuid are provided", () => {
    const result = buildRandomTempFilePath({
      prefix: "line-media",
      extension: ".jpg",
      tmpDir: "/tmp",
      now: 123,
      uuid: "abc",
    });
    expect(result).toBe(path.join("/tmp", "line-media-123-abc.jpg"));
  });

  it("sanitizes prefix and extension to avoid path traversal segments", () => {
    const tmpRoot = path.resolve(resolvePreferredOpenClawTmpDir());
    const result = buildRandomTempFilePath({
      prefix: "../../line/../media",
      extension: "/../.jpg",
      now: 123,
      uuid: "abc",
    });
    const resolved = path.resolve(result);
    const rel = path.relative(tmpRoot, resolved);
    expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.basename(result)).toBe("line-media-123-abc.jpg");
    expect(result).not.toContain("..");
  });
});

describe("withTempDownloadPath", () => {
  it("creates a temp path under tmp dir and cleans up the temp directory", async () => {
    let capturedPath = "";
    await withTempDownloadPath(
      {
        prefix: "line-media",
      },
      async (tmpPath) => {
        capturedPath = tmpPath;
        await fs.writeFile(tmpPath, "ok");
      },
    );

    expect(capturedPath).toContain(path.join(resolvePreferredOpenClawTmpDir(), "line-media-"));
    await expect(fs.stat(capturedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sanitizes prefix and fileName", async () => {
    const tmpRoot = path.resolve(resolvePreferredOpenClawTmpDir());
    let capturedPath = "";
    await withTempDownloadPath(
      {
        prefix: "../../line/../media",
        fileName: "../../evil.bin",
      },
      async (tmpPath) => {
        capturedPath = tmpPath;
      },
    );

    const resolved = path.resolve(capturedPath);
    const rel = path.relative(tmpRoot, resolved);
    expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.basename(capturedPath)).toBe("evil.bin");
    expect(capturedPath).not.toContain("..");
  });
});

describe("buildAgentWorkspaceArtifactPath", () => {
  it("places artifacts inside the resolved agent workspace", () => {
    const output = buildAgentWorkspaceArtifactPath({
      cfg,
      agentId: "ops",
      prefix: "feishu-resource",
      preferredFileName: "weekly-report.xlsx",
      pathSegments: [".openclaw", "artifacts", "feishu"],
      now: 123,
      uuid: "abc",
    });

    expect(output.workspaceDir).toBe("/Users/admin/.openclaw/workspace-ops");
    expect(output.absolutePath).toBe(
      "/Users/admin/.openclaw/workspace-ops/.openclaw/artifacts/feishu/weekly-report-123-abc.xlsx",
    );
    expect(output.workspacePath).toBe(".openclaw/artifacts/feishu/weekly-report-123-abc.xlsx");
  });

  it("sanitizes dot segments in artifact paths so they cannot escape the workspace", () => {
    const output = buildAgentWorkspaceArtifactPath({
      cfg,
      agentId: "ops",
      prefix: "feishu-resource",
      pathSegments: ["..", "feishu"],
      now: 1,
      uuid: "abc",
    });

    expect(output.absolutePath).toBe(
      "/Users/admin/.openclaw/workspace-ops/artifact/feishu/feishu-resource-1-abc",
    );
    expect(output.workspacePath).toBe("artifact/feishu/feishu-resource-1-abc");
  });
});

describe("resolveAgentWorkspaceOutputPath", () => {
  it("auto-generates a workspace-local artifact path when output_path is omitted", () => {
    const output = resolveAgentWorkspaceOutputPath({
      cfg,
      agentId: "ops",
      prefix: "drive-file",
      preferredFileName: "summary.pdf",
      pathSegments: [".openclaw", "artifacts", "feishu"],
      now: 456,
      uuid: "xyz",
    });

    expect(output.absolutePath).toBe(
      "/Users/admin/.openclaw/workspace-ops/.openclaw/artifacts/feishu/summary-456-xyz.pdf",
    );
    expect(output.workspacePath).toBe(".openclaw/artifacts/feishu/summary-456-xyz.pdf");
  });

  it("resolves relative output paths inside the agent workspace", () => {
    const output = resolveAgentWorkspaceOutputPath({
      cfg,
      agentId: "ops",
      prefix: "drive-file",
      outputPath: "exports/report.xlsx",
    });

    expect(output.absolutePath).toBe("/Users/admin/.openclaw/workspace-ops/exports/report.xlsx");
    expect(output.workspacePath).toBe("exports/report.xlsx");
  });

  it("rejects relative output paths that escape the agent workspace", () => {
    expect(() =>
      resolveAgentWorkspaceOutputPath({
        cfg,
        agentId: "ops",
        prefix: "drive-file",
        outputPath: "../outside/report.xlsx",
      }),
    ).toThrow("output_path must stay within the current workspace");
  });

  it("rejects absolute output paths outside the agent workspace", () => {
    expect(() =>
      resolveAgentWorkspaceOutputPath({
        cfg,
        agentId: "ops",
        prefix: "drive-file",
        outputPath: "/tmp/outside/report.xlsx",
      }),
    ).toThrow("output_path must stay within the current workspace");
  });
});
