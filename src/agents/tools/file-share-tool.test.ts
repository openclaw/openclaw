import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AliyunOssConfig } from "../../infra/aliyun-oss.js";
import { createFileShareTool } from "./file-share-tool.js";

const TEST_CONFIG: AliyunOssConfig = {
  accessKeyId: "ak",
  accessKeySecret: "sk",
  bucket: "leadingnews",
  endpoint: "oss-cn-beijing.aliyuncs.com",
  customDomain: "https://oss.ibtai.com",
  pathPrefix: "ibtai/assistant-agent/outputs",
  maxFileSizeMb: 1,
  allowedExtensions: ["docx", "pdf", "txt"],
};

describe("file_share tool", () => {
  let workspaceDir: string;
  let uploads: Array<{ localPath: string; displayName: string }>;

  function makeTool(configOverride?: Partial<AliyunOssConfig> | null) {
    return createFileShareTool({
      workspaceDir,
      agentSessionKey: "agent:rabbitmq-2005:rabbitmq:2005:session_x",
      deps: {
        resolveConfig: () =>
          configOverride === null ? null : { ...TEST_CONFIG, ...configOverride },
        uploadFile: async ({ localPath, displayName }) => {
          uploads.push({ localPath, displayName });
          return {
            url: "https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026/6/12/1_ab12cd34.docx",
            objectKey: "ibtai/assistant-agent/outputs/2026/6/12/1_ab12cd34.docx",
            size: 10,
          };
        },
      },
    });
  }

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-share-ws-"));
    uploads = [];
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("is unavailable without OSS config or workspace", () => {
    expect(makeTool(null)).toBeNull();
    expect(
      createFileShareTool({
        deps: {
          resolveConfig: () => TEST_CONFIG,
          uploadFile: async () => ({ url: "", objectKey: "", size: 0 }),
        },
      }),
    ).toBeNull();
  });

  it("uploads a workspace file and returns the public URL", async () => {
    await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "reports", "速报.docx"), "content");

    const tool = makeTool();
    const result = await tool!.execute("call-1", { path: "reports/速报.docx" });
    const payload = (result as { details?: unknown }).details as Record<string, unknown>;

    expect(payload.ok).toBe(true);
    expect(payload.url).toContain("https://oss.ibtai.com/");
    expect(payload.filename).toBe("速报.docx");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].displayName).toBe("速报.docx");
  });

  it("honors a custom display filename and strips path separators", async () => {
    await fs.writeFile(path.join(workspaceDir, "out.pdf"), "x");
    const tool = makeTool();
    const result = await tool!.execute("call-2", {
      path: "out.pdf",
      filename: "../报告/最终版.pdf",
    });
    const payload = (result as { details?: unknown }).details as Record<string, unknown>;
    expect(payload.filename).toBe(".._报告_最终版.pdf");
  });

  it("rejects paths outside the workspace", async () => {
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
    await fs.writeFile(outside, "secret");
    try {
      const tool = makeTool();
      await expect(tool!.execute("call-3", { path: outside })).rejects.toThrow(
        /inside the agent workspace/,
      );
      await expect(tool!.execute("call-4", { path: "../escape.txt" })).rejects.toThrow();
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("rejects missing files, oversize files, and disallowed extensions", async () => {
    const tool = makeTool();
    await expect(tool!.execute("c", { path: "nope.docx" })).rejects.toThrow(/not found/);

    await fs.writeFile(path.join(workspaceDir, "big.pdf"), Buffer.alloc(1.5 * 1024 * 1024));
    await expect(tool!.execute("c", { path: "big.pdf" })).rejects.toThrow(/too large/);

    await fs.writeFile(path.join(workspaceDir, "run.exe"), "bin");
    await expect(tool!.execute("c", { path: "run.exe" })).rejects.toThrow(/not allowed/);
  });

  it("hides upload failures behind a generic error", async () => {
    await fs.writeFile(path.join(workspaceDir, "a.txt"), "x");
    const tool = createFileShareTool({
      workspaceDir,
      deps: {
        resolveConfig: () => TEST_CONFIG,
        uploadFile: async () => {
          throw new Error("HTTP 403 SignatureDoesNotMatch at oss-cn-beijing");
        },
      },
    });
    await expect(tool!.execute("c", { path: "a.txt" })).rejects.toThrow(
      /Could not upload the file right now/,
    );
  });
});
