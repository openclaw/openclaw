import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("drains complete scanner reports before a failed verification exits", async () => {
  const root = tempDirs.make("openclaw-verify-output-");
  const configPath = path.join(root, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: { workspace: root } } }));
  const scannerReports = {
    aig: {
      version: "2.1.0",
      runs: [{ results: [], properties: { upstreamDetails: { checks: ["completed"] } } }],
    },
    skillspector: {
      risk_assessment: { score: 0, recommendation: "CAUTION" },
      analysis_completeness: { is_complete: false, coverage_percent: 99.1 },
      components: Array.from({ length: 235 }, (_, index) => ({
        path: `references/service-${index}.md`,
        upstreamDetails: { context: "  report detail\n".repeat(5500) },
      })),
    },
  };
  const verification = {
    schema: "clawhub.skill.verify.v1",
    ok: false,
    decision: "fail",
    reasons: ["security.status_not_clean"],
    slug: "weather",
    publisherHandle: "demo-owner",
    version: "2.0.0",
    security: { status: "suspicious", scannerReports },
    provenance: null,
  };
  const body = JSON.stringify(verification);
  expect(Buffer.byteLength(body)).toBeGreaterThan(18 * 1024 * 1024);
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
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ ...verification, openclaw: expect.any(Object) });
    expect(requests).toEqual([
      "/api/v1/skills/weather/verify?version=2.0.0&ownerHandle=demo-owner",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
