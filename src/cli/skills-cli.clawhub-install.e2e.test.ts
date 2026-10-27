import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import { readRequestText as readRequestBody } from "../../test/helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { spawnOpenClaw } from "./clawhub-install.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
function reply(res: ServerResponse, body: unknown, type = "application/json", status = 200) {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

it("installs a ClawHub GitHub skill through the CLI and reports telemetry", async () => {
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

    switch (`${req.method} ${url.pathname}`) {
      case "GET /api/v1/skills/aiq-deploy/install":
        return reply(res, {
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
      case `GET /NVIDIA/skills/zip/${commit}`:
        return reply(res, githubZipBytes, "application/zip");
      case "POST /api/cli/telemetry/install":
        telemetryBodies.push(JSON.parse(await readRequestBody(req)) as unknown);
        return reply(res, { ok: true });
      default:
        return reply(res, "not found", "text/plain; charset=utf-8", 404);
    }
  }
  const stateDir = directories.make("openclaw-clawhub-cli-e2e-");
  await withServer(
    (req, res) => {
      void handleRequest(req, res).catch((error: unknown) => {
        reply(res, String(error), "text/plain; charset=utf-8", 500);
      });
    },
    async (registry) => {
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
      await expect(readInstalled("other/SKILL.md")).rejects.toThrow();
      expect(telemetryBodies, `Install requests: ${requestLog.join(", ")}`).toHaveLength(1);
      expect(telemetryBodies[0]).toMatchObject({
        event: "install",
        slug: "aiq-deploy",
        ownerHandle: "demo-owner",
        version: commit,
      });
    },
  );
}, 30_000);
