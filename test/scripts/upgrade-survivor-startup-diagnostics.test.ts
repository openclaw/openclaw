import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import { redactSensitiveText } from "../../src/logging/redact.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();
const observer = path.resolve("scripts/e2e/lib/upgrade-survivor/startup-diagnostics.mjs");
const runner = path.resolve("scripts/e2e/lib/upgrade-survivor/run.sh");
const servers: Server[] = [];
const secret = "sk-startupDiagnosticSecret1234567890";

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture has no TCP port");
  }
  return address.port;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      command,
      args,
      { env, timeout: 15_000, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(new Error("Diagnostic fixture command could not complete", { cause: error }));
          return;
        }
        resolve({ status: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      },
    );
  });
}

describe.skipIf(process.platform === "win32")("survivor startup failure diagnostics", () => {
  it.each([false, true])(
    "preserves the readiness failure and captures before cleanup when late readiness is %s",
    async (ready) => {
      const requests: string[] = [];
      const port = await listen((req, res) => {
        requests.push(req.url ?? "");
        res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            req.url === "/readyz"
              ? { ready, failing: ready ? [] : ["startup"], uptimeMs: 91_000, privateData: secret }
              : {
                  ok: ready,
                  status: ready ? "started" : "starting",
                  pendingReason: `model-runtime ${secret}`,
                  uptimeMs: 91_001,
                  version: "2026.9.6",
                  privateData: "UNLISTED_STARTUP_FIELD",
                },
          ),
        );
      });
      const root = dirs.make("survivor-startup-failure-");
      const state = path.join(root, "state");
      const artifacts = path.join(root, "artifacts");
      const bin = path.join(root, "bin");
      for (const directory of [state, artifacts, bin]) {
        fs.mkdirSync(directory);
      }
      fs.writeFileSync(path.join(bin, "openclaw"), "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });
      const prelude = path.join(root, "bash-env");
      // Keep the real startup, error trap, diagnostic publication and cleanup ordering.
      fs.writeFileSync(
        prelude,
        `install_fixture_phases() {
  trap - DEBUG
  eval "$(declare -f stop_gateway | sed '1s/stop_gateway/real_stop_gateway/')"
  node() {
    if [ "\${1:-}" = scripts/e2e/lib/upgrade-survivor/startup-diagnostics.mjs ]; then
      command node "$1" "$FIXTURE_PORT"
    else
      command node "$@"
    fi
  }
  openclaw_e2e_wait_gateway_ready() { return 42; }
  stop_gateway() {
    if [ -s "$ARTIFACT_ROOT/gateway-startup-probes.json" ]; then
      printf 'captured-before-cleanup\\n' >"$HOME/cleanup-order"
    fi
    real_stop_gateway
  }
  phase gateway-start ensure_gateway_started
  exit $?
}
trap 'case "$BASH_COMMAND" in "phase "*) install_fixture_phases ;; esac' DEBUG
`,
      );
      const result = await run("/bin/bash", [runner], {
        PATH: `${bin}:${path.dirname(node)}:/usr/bin:/bin`,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
        OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: path.join(root, "runtime"),
        OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: path.join(artifacts, "summary.json"),
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.9.1",
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base",
        BASH_ENV: prelude,
        FIXTURE_PORT: String(port),
      });
      expect(result.status, result.stderr).toBe(42);
      expect(fs.existsSync(path.join(artifacts, "gateway-startup-probes.json"))).toBe(true);
      expect(fs.readFileSync(path.join(root, "cleanup-order"), "utf8")).toBe(
        "captured-before-cleanup\n",
      );
      expect(requests).toEqual(["/readyz", "/startupz"]);
      const destination = path.join(root, "public");
      publishDiagnostics(artifacts, destination, redactSensitiveText);
      const published = fs.readFileSync(path.join(destination, "failure.json"), "utf8");
      expect(published).not.toContain(secret);
      expect(published).not.toContain("UNLISTED_STARTUP_FIELD");
      const report = JSON.parse(published);
      expect(report.exitStatus).toBe(42);
      const observation = JSON.parse(report.logs["gateway-startup-probes.json"]);
      expect(observation).toMatchObject({
        afterReadinessFailure: true,
        probes: {
          "/readyz": { availability: "captured", httpStatus: ready ? 200 : 503, body: { ready } },
          "/startupz": {
            availability: "captured",
            body: { status: ready ? "started" : "starting", version: "2026.9.6" },
          },
        },
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(artifacts, "summary.json"), "utf8")),
      ).toMatchObject({
        status: "failed",
        failure: { phase: "gateway-start" },
      });
    },
  );
});

it.each(["oversized", "stalled", "redirect"])(
  "bounds %s diagnostic responses without retrying or following redirects",
  async (mode) => {
    const requests: string[] = [];
    const port = await listen((req, res) => {
      requests.push(req.url ?? "");
      if (mode === "redirect") {
        res.writeHead(302, { location: "/unexpected" });
        res.end();
      } else if (mode === "oversized") {
        res.end("x".repeat(16 * 1024 + 1));
      } else {
        res.writeHead(503, { "content-type": "application/json" });
        res.write('{"ready":');
      }
    });
    const result = await run(node, [observer, String(port)]);
    expect(result.status, result.stderr).toBe(0);
    expect(requests).toEqual(["/readyz", "/startupz"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      afterReadinessFailure: true,
      probes: {
        "/readyz": { availability: "unavailable" },
        "/startupz": { availability: "unavailable" },
      },
    });
  },
);
