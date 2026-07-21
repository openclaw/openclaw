import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { getSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";
import { installGatewayTestHooks, onceMessage, testState } from "./test-helpers.js";
import { testConfigRoot } from "./test-helpers.runtime-state.js";

installGatewayTestHooks();

type RpcResponse = {
  type?: string;
  id?: string;
  ok?: boolean;
  payload?: Record<string, unknown> | null;
  error?: { message?: string };
};

async function request(
  ws: WebSocket,
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcResponse> {
  const response = onceMessage<RpcResponse>(
    ws,
    (message) => message.type === "res" && message.id === id,
  );
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return await response;
}

describe("skills write service Gateway flow", () => {
  test("routes canonical proposals and uploaded bundle installs through a real server", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("Gateway test state directory is unavailable");
    }
    const workspaceDir = path.join(stateDir, "workspace");
    testState.agentConfig = { workspace: workspaceDir };
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(testConfigRoot.value, "openclaw.json"),
      `${JSON.stringify({ skills: { install: { allowUploadedArchives: true } } })}\n`,
    );
    const harness = await startGatewayServerHarness();
    const clients: WebSocket[] = [];

    try {
      const admin = await harness.openClient();
      clients.push(admin.ws);
      const readOnly = await harness.openClient({ scopes: ["operator.read"] });
      clients.push(readOnly.ws);

      await expect(
        request(readOnly.ws, "propose-read", "skills.proposals.create", {
          name: "gateway-e2e-forbidden",
          description: "Must require the existing mutation scope",
          content: "# Forbidden\n",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("operator.admin") },
      });

      const proposal = await request(admin.ws, "propose", "skills.proposals.create", {
        name: "gateway-e2e-proposal",
        description: "Apply through the canonical Gateway API",
        content: "# Proposal\n",
      });
      expect(proposal, JSON.stringify(proposal)).toMatchObject({
        ok: true,
        payload: { record: { status: "pending" } },
      });
      const proposalId = (proposal.payload as { record: { id: string } }).record.id;
      const apply = await request(admin.ws, "apply", "skills.proposals.apply", { proposalId });
      expect(apply, JSON.stringify(apply)).toMatchObject({
        ok: true,
        payload: { record: { status: "applied" } },
      });
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", "gateway-e2e-proposal", "SKILL.md"), "utf8"),
      ).resolves.toContain("# Proposal");

      const archive = new JSZip();
      archive.file(
        "bundle/SKILL.md",
        [
          "---",
          "name: gateway-e2e-upload",
          "description: Install through the real Gateway server",
          "---",
          "",
          "# Uploaded",
          "",
        ].join("\n"),
      );
      archive.file("bundle/scripts/helper.sh", "#!/bin/sh\necho gateway-e2e\n");
      const archiveBytes = Buffer.from(await archive.generateAsync({ type: "nodebuffer" }));
      const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
      const uploadBegin = await request(admin.ws, "upload-begin", "skills.upload.begin", {
        kind: "skill-archive",
        slug: "gateway-e2e-upload",
        sizeBytes: archiveBytes.length,
        sha256: archiveSha256,
      });
      expect(uploadBegin, JSON.stringify(uploadBegin)).toMatchObject({
        ok: true,
        payload: { uploadId: expect.any(String) },
      });
      const uploadId = (uploadBegin.payload as { uploadId: string }).uploadId;
      await expect(
        request(admin.ws, "upload-chunk", "skills.upload.chunk", {
          uploadId,
          offset: 0,
          dataBase64: archiveBytes.toString("base64"),
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        request(admin.ws, "upload-commit", "skills.upload.commit", {
          uploadId,
          sha256: archiveSha256,
        }),
      ).resolves.toMatchObject({ ok: true });

      const versionBeforeInstall = getSkillsSnapshotVersion(workspaceDir);
      await expect(
        request(admin.ws, "install", "skills.install", {
          source: "upload",
          uploadId,
          slug: "gateway-e2e-upload",
          sha256: archiveSha256,
        }),
      ).resolves.toMatchObject({
        ok: true,
        payload: { ok: true, slug: "gateway-e2e-upload", sha256: archiveSha256 },
      });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(versionBeforeInstall);
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", "gateway-e2e-upload", "SKILL.md"), "utf8"),
      ).resolves.toContain("# Uploaded");
      await expect(
        fs.readFile(
          path.join(workspaceDir, "skills", "gateway-e2e-upload", "scripts", "helper.sh"),
          "utf8",
        ),
      ).resolves.toContain("echo gateway-e2e");
    } finally {
      for (const client of clients) {
        client.close();
      }
      await harness.close();
    }
  });
});
