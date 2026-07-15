import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
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

describe("skills write Gateway RPC", () => {
  test("writes through a real server and enforces mutation scopes", async () => {
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
      const directContent = [
        "---",
        "name: gateway-e2e-direct",
        "description: Write through the real Gateway server",
        "---",
        "",
        "# Direct",
        "",
      ].join("\n");

      await expect(
        request(readOnly.ws, "validate-read", "skills.write.validate", {
          name: "gateway-e2e-direct",
          content: directContent,
        }),
      ).resolves.toMatchObject({
        ok: true,
        payload: { name: "gateway-e2e-direct", scan: { state: "clean" } },
      });
      await expect(
        request(readOnly.ws, "direct-read", "skills.write.direct", {
          mode: "create",
          name: "gateway-e2e-forbidden",
          content: directContent.replaceAll("gateway-e2e-direct", "gateway-e2e-forbidden"),
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("operator.admin") },
      });

      const proposal = await request(admin.ws, "propose", "skills.write.propose", {
        kind: "create",
        name: "gateway-e2e-proposal",
        description: "Apply through the real Gateway server",
        content: "# Proposal\n",
      });
      expect(proposal, JSON.stringify(proposal)).toMatchObject({
        ok: true,
        payload: { record: { status: "pending" } },
      });
      const proposalId = (proposal.payload as { record: { id: string } }).record.id;
      const apply = await request(admin.ws, "apply", "skills.write.applyProposal", { proposalId });
      expect(apply, JSON.stringify(apply)).toMatchObject({
        ok: true,
        payload: { record: { status: "applied" } },
      });

      const direct = await request(admin.ws, "direct", "skills.write.direct", {
        mode: "create",
        name: "gateway-e2e-direct",
        content: directContent,
        supportFiles: [{ path: "references/notes.txt", content: "Gateway E2E\n" }],
        refresh: false,
      });
      expect(direct).toMatchObject({
        ok: true,
        payload: {
          targetSkillFile: expect.any(String),
          rollback: { action: "create" },
        },
      });
      expect(direct.payload?.snapshotVersion).toBeUndefined();
      const targetSkillFile = direct.payload?.targetSkillFile;
      expect(typeof targetSkillFile).toBe("string");
      if (typeof targetSkillFile !== "string") {
        throw new Error("skills.write.direct did not return targetSkillFile");
      }
      await expect(fs.readFile(targetSkillFile, "utf8")).resolves.toBe(directContent);
      await expect(
        fs.readFile(path.join(path.dirname(targetSkillFile), "references", "notes.txt"), "utf8"),
      ).resolves.toBe("Gateway E2E\n");
      expect(path.dirname(path.dirname(path.dirname(targetSkillFile)))).toBe(workspaceDir);
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
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", "gateway-e2e-upload", "SKILL.md"), "utf8"),
      ).resolves.toContain("# Uploaded");
      await expect(
        fs.readFile(
          path.join(workspaceDir, "skills", "gateway-e2e-upload", "scripts", "helper.sh"),
          "utf8",
        ),
      ).resolves.toContain("echo gateway-e2e");

      await expect(
        request(admin.ws, "refresh", "skills.write.refreshSnapshot", {}),
      ).resolves.toMatchObject({
        ok: true,
        payload: { snapshotVersion: expect.any(Number) },
      });
    } finally {
      for (const client of clients) {
        client.close();
      }
      await harness.close();
    }
  });
});
