import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, get, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { closeHttpServer, listenLoopback } from "../helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { stopChildProcess } from "../helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stopChildProcess(child, 1_000)));
  await Promise.all(servers.splice(0).map(closeHttpServer));
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function startUpstream(body: string) {
  const requests: string[] = [];
  const server = createServer((incoming, response) => {
    requests.push(incoming.url ?? "");
    response.end(body);
  });
  servers.push(server);
  return { url: await listenLoopback(server), requests };
}

it("pins registry upstreams and preserves Codex availability", async ({ signal }) => {
  const root = tempDirs.make("openclaw-missing-plugin-proxy-");
  const upstream = await startUpstream("upstream");
  const decoy = await startUpstream("decoy");
  const portFile = path.join(root, "ports.json");
  const child = spawn(
    resolveTestNodeExecPath(),
    [
      "--input-type=module",
      "-e",
      `import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
// The serve module settles after both listeners bind and the ports file is renamed.
await import(pathToFileURL(process.argv[1]).href);
process.send(JSON.parse(readFileSync(process.argv[3], "utf8")));`,
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
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  children.push(child);
  const [ready, closed] = [once(child, "message"), once(child, "close")];
  const [ports] = await withinTest(
    awaitGateBeforeSettlement(ready, closed, `Child exited before writing ${portFile}`),
    signal,
  );
  const endpoints = z.object({ npm: z.url(), clawhub: z.url() }).parse(ports);

  for (const proxy of [endpoints.npm, endpoints.clawhub]) {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      get(proxy, { path: `${decoy.url}/probe?package=fixture` }, resolve).on("error", reject);
    });
    expect(await text(response)).toBe("upstream");
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
