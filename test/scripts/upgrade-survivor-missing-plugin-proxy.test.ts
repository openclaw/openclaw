import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { waitForFixtureFile } from "../helpers/process-wait.js";
import { stopChildProcess } from "../helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stopChildProcess(child, 1_000)));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function startUpstream(body: string) {
  const requests: string[] = [];
  const server = createServer((incoming, response) => {
    requests.push(incoming.url ?? "");
    response.end(body);
  });
  servers.push(server);
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture upstream did not bind a TCP port");
  }
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

it("pins both registry proxies to their upstream while preserving Codex availability", async () => {
  const root = tempDirs.make("openclaw-missing-plugin-proxy-");
  const upstream = await startUpstream("upstream");
  const decoy = await startUpstream("decoy");
  const portFile = path.join(root, "ports.json");
  const child = spawn(
    resolveTestNodeExecPath(),
    [
      "scripts/e2e/lib/upgrade-survivor/missing-configured-plugin-migration.mjs",
      "serve",
      portFile,
      upstream.url,
      upstream.url,
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      },
      stdio: "ignore",
    },
  );
  children.push(child);
  await waitForFixtureFile(portFile, once(child, "close"));
  const endpoints = z
    .object({ npm: z.url(), clawhub: z.url() })
    .parse(JSON.parse(readFileSync(portFile, "utf8")));

  for (const proxy of [endpoints.npm, endpoints.clawhub]) {
    const body = await new Promise<string>((resolve, reject) => {
      const outgoing = request(
        proxy,
        { path: `${decoy.url}/probe?package=fixture` },
        (response) => {
          let contents = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            contents += chunk;
          });
          response.on("end", () => resolve(contents));
          response.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(body).toBe("upstream");
  }
  expect(decoy.requests).toEqual([]);
  expect(upstream.requests).toEqual(["/probe?package=fixture", "/probe?package=fixture"]);

  const codexPath = "/@openclaw%2Fcodex";
  const blocked = await fetch(`${endpoints.npm}${codexPath}`);
  expect(blocked.status).toBe(404);
  await blocked.body?.cancel();
  const available = await fetch(`${endpoints.npm}/__fixture__/available`, { method: "POST" });
  expect(available.ok).toBe(true);
  await available.body?.cancel();
  expect(await (await fetch(`${endpoints.npm}${codexPath}`)).text()).toBe("upstream");
  expect(upstream.requests.at(-1)).toBe(codexPath);
});
