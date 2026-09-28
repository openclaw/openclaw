import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("skills verify process output", () => {
  it.each([
    { label: "failed default JSON", pass: false, json: false, reportsAvailable: true },
    { label: "passed explicit JSON", pass: true, json: true, reportsAvailable: true },
    { label: "unavailable reports", pass: false, json: false, reportsAvailable: false },
  ])(
    "preserves complete scanner reports through $label",
    async ({ pass, json, reportsAvailable }) => {
      const root = tempDirs.make("openclaw-verify-output-");
      const configPath = path.join(root, "openclaw.json");
      await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: { workspace: root } } }));
      const scannerReports = {
        aig: reportsAvailable
          ? {
              version: "2.1.0",
              runs: [{ results: [], properties: { upstreamDetails: { checks: ["completed"] } } }],
            }
          : null,
        skillspector: reportsAvailable
          ? {
              risk_assessment: { score: 0, recommendation: pass ? "SAFE" : "CAUTION" },
              analysis_completeness: { is_complete: pass, coverage_percent: pass ? 100 : 99.1 },
              components: Array.from({ length: 235 }, (_, index) => ({
                path: `references/service-${index}.md`,
                upstreamDetails: { context: "  report detail\n".repeat(5500) },
              })),
            }
          : null,
      };
      const verification = {
        schema: "clawhub.skill.verify.v1",
        ok: pass,
        decision: pass ? "pass" : "fail",
        reasons: pass ? [] : ["security.status_not_clean"],
        slug: "weather",
        publisherHandle: "demo-owner",
        version: "2.0.0",
        security: { status: pass ? "clean" : "suspicious", scannerReports },
        provenance: null,
      };
      const body = JSON.stringify(verification);
      if (reportsAvailable) {
        expect(Buffer.byteLength(body)).toBeGreaterThan(18 * 1024 * 1024);
      }
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(request.url ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("HTTP fixture did not bind a TCP port");
        }
        const result = await runCliProcessChild({
          nodeArgs: [
            ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
            "skills",
            "verify",
            "@demo-owner/weather",
            "--version",
            "2.0.0",
            ...(json ? ["--json"] : []),
          ],
          env: {
            PATH: process.env.PATH,
            ESBUILD_WORKER_THREADS: process.env.ESBUILD_WORKER_THREADS,
            HOME: root,
            USERPROFILE: root,
            NODE_DISABLE_COMPILE_CACHE: "1",
            OPENCLAW_NO_RESPAWN: "1",
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_CLAWHUB_URL: `http://127.0.0.1:${address.port}`,
            NO_COLOR: "1",
          },
        });

        expect(result.signal, result.stderr).toBeNull();
        expect(result.code, result.stderr).toBe(pass ? 0 : 1);
        const output = JSON.parse(result.stdout);
        expect(output.security).toBeDefined();
        expect(output).toEqual({
          ...verification,
          openclaw: expect.any(Object),
        });
        expect(requests).toEqual([
          "/api/v1/skills/weather/verify?version=2.0.0&ownerHandle=demo-owner",
        ]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
