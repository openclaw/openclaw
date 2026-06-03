import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillsHandlers } from "./skills.js";
import type { GatewayRequestHandlers } from "./types.js";

type CallResult = {
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
};

let tempDirs: string[] = [];

function makeContext(config: Record<string, unknown>) {
  return {
    getRuntimeConfig: () => config,
    logGateway: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

async function call(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<CallResult> {
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`missing handler: ${method}`);
  }
  let result: CallResult | undefined;
  await handler({
    params,
    req: { method } as never,
    client: null,
    isWebchatConnect: () => false,
    context: makeContext(config) as never,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
  });
  if (!result) {
    throw new Error(`handler did not respond: ${method}`);
  }
  return result;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeSkillArchive(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "proof-skill/SKILL.md",
    ["---", "name: Proof Upload", "description: Agent workspace proof", "---", "", "# Proof Upload", ""].join(
      "\n",
    ),
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("skill upload gateway handlers with explicit agent workspace", () => {
  beforeEach(() => {
    tempDirs = [];
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("installs uploaded skill archives into the requested agent workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-agent-proof-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const mainWorkspace = path.join(root, "workspace-main");
    const writerWorkspace = path.join(root, "workspace-writer");
    await fs.mkdir(mainWorkspace, { recursive: true });
    await fs.mkdir(writerWorkspace, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const config = {
      skills: { install: { allowUploadedArchives: true } },
      agents: {
        list: [
          { id: "main", default: true, workspace: mainWorkspace },
          { id: "writer", workspace: writerWorkspace },
        ],
      },
    };
    const archive = await makeSkillArchive();
    const digest = sha256(archive);

    const begin = await call(
      skillsHandlers,
      "skills.upload.begin",
      {
        kind: "skill-archive",
        slug: "proof-upload",
        sizeBytes: archive.length,
        sha256: digest,
      },
      config,
    );
    expect(begin.ok).toBe(true);
    const uploadId = (begin.payload as { uploadId: string }).uploadId;

    const chunk = await call(
      skillsHandlers,
      "skills.upload.chunk",
      {
        uploadId,
        offset: 0,
        dataBase64: archive.toString("base64"),
      },
      config,
    );
    expect(chunk.ok).toBe(true);

    const commit = await call(
      skillsHandlers,
      "skills.upload.commit",
      {
        uploadId,
        sha256: digest,
      },
      config,
    );
    expect(commit.ok).toBe(true);

    const install = await call(
      skillsHandlers,
      "skills.install",
      {
        source: "upload",
        agentId: "writer",
        uploadId,
        slug: "proof-upload",
        sha256: digest,
      },
      config,
    );
    expect(install.ok).toBe(true);
    expect((install.payload as { targetDir?: string }).targetDir).toBe(
      path.join(writerWorkspace, "skills", "proof-upload"),
    );
    await expect(
      fs.readFile(path.join(writerWorkspace, "skills", "proof-upload", "SKILL.md"), "utf8"),
    ).resolves.toContain("Proof Upload");
    await expect(
      fs.stat(path.join(mainWorkspace, "skills", "proof-upload", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
