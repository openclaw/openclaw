import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { readRequestBody, spawnOpenClaw } from "./clawhub-install.test-support.js";

function reply(res: ServerResponse, body: unknown, type = "application/json", status = 200) {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

describe("openclaw skills install ClawHub GitHub-backed E2E", () => {
  it("installs from the install resolver and reports install telemetry", async () => {
    const commit = "c".repeat(40);
    const telemetryBodies: unknown[] = [];
    const requestLog: string[] = [];
    const zip = new JSZip();
    zip.file("skills-main/skills/aiq-deploy/SKILL.md", "# AIQ Deploy\n");
    zip.file("skills-main/skills/aiq-deploy/skill-card.md", "# Card\n");
    zip.file("skills-main/skills/other/SKILL.md", "# Other\n");
    const githubZipBytes = await zip.generateAsync({ type: "nodebuffer" });
    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      requestLog.push(`${req.method ?? "GET"} ${url.pathname}`);

      if (req.method === "GET" && url.pathname === "/api/v1/skills/aiq-deploy/install") {
        reply(res, {
          ok: true,
          slug: "aiq-deploy",
          installKind: "github",
          github: {
            repo: "NVIDIA/skills",
            path: "skills/aiq-deploy",
            commit,
            contentHash: "hash-aiq-deploy",
            sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
          },
        });
        return;
      }

      if (req.method === "GET" && url.pathname === `/NVIDIA/skills/zip/${commit}`) {
        reply(res, githubZipBytes, "application/zip");
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cli/telemetry/install") {
        telemetryBodies.push(JSON.parse(await readRequestBody(req)) as unknown);
        reply(res, { ok: true });
        return;
      }

      reply(res, "not found", "text/plain; charset=utf-8", 404);
    }
    const server = createServer((req, res) => {
      void handleRequest(req, res).catch((error: unknown) => {
        reply(
          res,
          error instanceof Error ? error.message : String(error),
          "text/plain; charset=utf-8",
          500,
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-cli-e2e-"));
    try {
      const result = await spawnOpenClaw(
        ["skills", "install", "@demo-owner/aiq-deploy", "--global"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
            OPENCLAW_CLAWHUB_URL: registry,
            CLAWHUB_TOKEN: "test-token",
            CLAWHUB_GITHUB_CODELOAD_BASE_URL: registry,
            CLAWHUB_DISABLE_TELEMETRY: "",
            CLAWDHUB_DISABLE_TELEMETRY: "",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
        },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      const readInstalled = (name: string) =>
        fs.readFile(path.join(stateDir, "skills", "aiq-deploy", name), "utf8");
      await expect(readInstalled("SKILL.md")).resolves.toContain("# AIQ Deploy");
      await expect(readInstalled("skill-card.md")).resolves.toContain("# Card");
      await expect(
        fs.readFile(path.join(stateDir, "skills", "aiq-deploy", "other", "SKILL.md")),
      ).rejects.toThrow();
      expect(telemetryBodies, `Install requests: ${requestLog.join(", ")}`).toHaveLength(1);
      expect(telemetryBodies[0]).toMatchObject({
        event: "install",
        slug: "aiq-deploy",
        ownerHandle: "demo-owner",
        version: commit,
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }, 30_000);
});
