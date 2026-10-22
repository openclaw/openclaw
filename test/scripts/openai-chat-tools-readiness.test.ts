import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import { afterEach, expect, it } from "vitest";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const pendingChildren = new Set<Promise<unknown>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await Promise.allSettled(pendingChildren);
    cleanup();
  }),
);

it("waits for agent readiness before the single chat tools request despite healthy RPC", async ({
  signal,
}) => {
  const workDir = tempDirs.make("openai-chat-tools-ready-");
  const entry = join(workDir, "healthy-rpc.mjs");
  const clientLog = join(workDir, "client.log");
  // Fixed external RPC result: health succeeds while agent admission is pending.
  writeFileSync(entry, "process.exit(0);\n");
  const readinessPending = createDeferred();
  const admit = createDeferred();
  const requests: Array<{ method: string | undefined; url: string | undefined }> = [];
  const chatRequests: Array<{
    authorization: string | undefined;
    model: string | undefined;
    body: unknown;
  }> = [];
  let readyProbes = 0;
  let ready = false;
  // Execute the scenario's actual startup-to-client boundary with a fixed healthy
  // RPC and an owned HTTP listener. Config/cold recall and a live model are outside this proof.
  const scenario = readFileSync("scripts/e2e/lib/openai-chat-tools/scenario.sh", "utf8");
  const start = scenario.indexOf('gateway_pid="$(openclaw_e2e_start_gateway');
  const end = scenario.indexOf(
    '\nif [ "${OPENCLAW_FROZEN_TARGET_SESSION_COLD_STORAGE_MODE:-required}"',
    start,
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const fixture = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        requests.push({ method: request.method, url: request.url });
        if (request.url === "/readyz") {
          readyProbes += 1;
          if (readyProbes === 1) {
            response
              .writeHead(503)
              .end(JSON.stringify({ ready: false, failing: ["agent-database:main"] }));
            return;
          }
          readinessPending.resolve();
          void admit.promise.then(() => {
            ready = true;
            response.end(JSON.stringify({ ready: true }));
          });
          return;
        }
        if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }
        if (!ready) {
          response
            .writeHead(503, { "Retry-After": "1" })
            .end("Agent database is starting. Please retry.");
          return;
        }
        void json(request).then((body: unknown) => {
          chatRequests.push({
            authorization: request.headers.authorization,
            model:
              typeof request.headers["x-openclaw-model"] === "string"
                ? request.headers["x-openclaw-model"]
                : undefined,
            body,
          });
          response.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        type: "function",
                        function: { name: "get_weather", arguments: '{"city":"Paris, France"}' },
                      },
                    ],
                  },
                },
              ],
            }),
          );
        });
      }),
  });
  const child = spawn(
    "/bin/bash",
    [
      "-c",
      `
set -euo pipefail
source scripts/lib/openclaw-e2e-instance.sh
# The listener belongs to this test, not a product Gateway process.
openclaw_e2e_start_gateway() { printf '%s' "$$"; }
sleep() { :; }
entry="$FIXTURE_ENTRY"
GATEWAY_LOG="$FIXTURE_GATEWAY_LOG"
CLIENT_LOG="$FIXTURE_CLIENT_LOG"
TOKEN="$OPENCLAW_GATEWAY_TOKEN"
MODEL_REF="$FIXTURE_MODEL"
${scenario.slice(start, end)}
`,
    ],
    {
      env: {
        ...process.env,
        PORT: String(fixture.claim.port),
        OPENCLAW_GATEWAY_TOKEN: "chat-tools-fixture-token",
        FIXTURE_ENTRY: entry,
        FIXTURE_GATEWAY_LOG: join(workDir, "gateway.log"),
        FIXTURE_CLIENT_LOG: clientLog,
        FIXTURE_MODEL: "openai/fixture-model",
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  pendingChildren.add(closed);
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        readinessPending.promise,
        closed.then((code) => {
          throw new Error(`scenario exited (${code}) before agent readiness: ${output}
${readFileSync(clientLog, "utf8")}`);
        }),
        "scenario exited before readiness",
      ),
      signal,
    );
    expect(requests).toEqual([
      { method: "GET", url: "/readyz" },
      { method: "GET", url: "/readyz" },
    ]);
    expect(chatRequests).toEqual([]);
    admit.resolve();
    expect(await withinTest(closed, signal), output).toBe(0);
    expect(requests.filter((request) => request.method === "POST")).toEqual([
      { method: "POST", url: "/v1/chat/completions" },
    ]);
    expect(chatRequests).toEqual([
      {
        authorization: "Bearer chat-tools-fixture-token",
        model: "openai/fixture-model",
        body: expect.objectContaining({ model: "openclaw", stream: false, tool_choice: "auto" }),
      },
    ]);
    expect(JSON.parse(readFileSync(clientLog, "utf8"))).toMatchObject({
      ok: true,
      toolName: "get_weather",
      args: { city: "Paris, France" },
    });
  } finally {
    admit.resolve();
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === "win32") {
        child.kill("SIGKILL");
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    }
    await closed;
    pendingChildren.delete(closed);
    fixture.listener.closeAllConnections();
    await fixture.releaseListener();
    await fixture.claim.release();
  }
});
