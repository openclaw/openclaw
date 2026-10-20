import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeEnv } from "../runtime.js";
import { searchSkillsFromClawHub } from "../skills/lifecycle/clawhub.js";
import { captureEnv } from "../test-utils/env.js";
import { runPluginsSearchCommand } from "./plugins-search-command.js";

const SCRIPT_PATH = "scripts/e2e/lib/clawhub-fixture-server.cjs";
type FixtureServer = { child: ChildProcess; closed: Promise<void> };
const servers: FixtureServer[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const previousEnv = captureEnv([
  "OPENCLAW_CLAWHUB_URL",
  "CLAWHUB_CONFIG_PATH",
  "CLAWHUB_TOKEN",
  "CLAWHUB_AUTH_TOKEN",
]);

afterEach(async () => {
  await Promise.all(servers.splice(0).map(stopServer));
  previousEnv.restore();
});

async function stopServer({ child, closed }: FixtureServer) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    // This grace owns signal escalation, not an assertion deadline for native retirement.
    await Promise.race([closed, delay(1_000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await closed;
}

async function startFixtureServer(signal: AbortSignal) {
  const root = tempDirs.make("clawhub-search-e2e-");
  const portFile = path.join(root, "port");
  const child = spawn(process.execPath, [SCRIPT_PATH, "catalog-search", portFile], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const closed = once(child, "close").then(() => {});
  servers.push({ child, closed });
  // Node's IPC overload does not retain the configured stdio tuple types.
  assert(child.stderr, "Fixture server stderr must be piped");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const listening = once(child, "message").then(([message]: unknown[]) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("port" in message) ||
      typeof message.port !== "number" ||
      !Number.isInteger(message.port) ||
      message.port <= 0
    ) {
      throw new Error(`fixture server did not write a port: ${stderr}`);
    }
    return message.port;
  });
  const port = await withinTest(
    awaitGateBeforeSettlement(
      listening,
      closed.then(() => {
        throw new Error(`fixture server exited early: ${stderr}`);
      }),
      "fixture server did not write a port",
    ),
    signal,
  );
  return { baseUrl: `http://127.0.0.1:${port}`, root };
}

function createRuntime() {
  return {
    log: vi.fn<RuntimeEnv["log"]>(),
    error: vi.fn<RuntimeEnv["error"]>(),
    exit: vi.fn<RuntimeEnv["exit"]>(),
  };
}

function output(runtime: ReturnType<typeof createRuntime>, stream: "log" | "error" = "log") {
  return runtime[stream].mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

it("keeps plugin discovery separate from skills and surfaces empty and failed lookups", async ({
  signal,
}) => {
  const { baseUrl, root } = await startFixtureServer(signal);
  process.env.OPENCLAW_CLAWHUB_URL = baseUrl;
  process.env.CLAWHUB_CONFIG_PATH = path.join(root, "missing-config.json");
  delete process.env.CLAWHUB_TOKEN;
  delete process.env.CLAWHUB_AUTH_TOKEN;

  const terminal = createRuntime();
  await runPluginsSearchCommand("calendar", { limit: 5 }, terminal);
  const terminalOutput = output(terminal);
  expect(terminal.exit).not.toHaveBeenCalled();
  expect(
    terminalOutput.split("\n").filter((line) => line.startsWith("@acme/calendar  ")),
  ).toHaveLength(1);
  expect(terminalOutput).toContain("bundle-plugin | official | v3.0.0");
  expect(terminalOutput).toContain("Install: openclaw plugins install @acme/calendar");
  expect(terminalOutput).not.toContain("calendar-skill");

  const json = createRuntime();
  await runPluginsSearchCommand("calendar", { json: true, limit: 5 }, json);
  const jsonOutput = JSON.parse(output(json)) as {
    results: Array<{ score: number; package: { name: string; family: string } }>;
  };
  expect(jsonOutput.results[0]).toMatchObject({
    score: 12,
    package: { name: "@acme/calendar", family: "bundle-plugin" },
  });
  expect(
    jsonOutput.results.filter((entry) => entry.package.name === "@acme/calendar"),
  ).toHaveLength(1);

  const skills = await searchSkillsFromClawHub({ query: "calendar", limit: 5, baseUrl });
  expect(skills).toEqual([expect.objectContaining({ score: 99, slug: "calendar-skill" })]);

  const empty = createRuntime();
  await runPluginsSearchCommand("empty", { limit: 5 }, empty);
  expect(empty.exit).not.toHaveBeenCalled();
  expect(empty.log.mock.calls).toEqual([["No ClawHub plugins found."]]);

  const unavailable = createRuntime();
  await runPluginsSearchCommand("unavailable", { limit: 5 }, unavailable);
  expect(unavailable.exit).toHaveBeenLastCalledWith(1);
  expect(output(unavailable, "error")).toContain("catalog unavailable");

  const response = await fetch(`${baseUrl}/__fixture__/requests`);
  expect(response.status).toBe(200);
  const { requests } = (await response.json()) as { requests: string[] };
  expect(requests).toEqual(
    expect.arrayContaining([
      "GET /api/v1/packages/search?q=calendar&family=code-plugin&limit=5",
      "GET /api/v1/packages/search?q=calendar&family=bundle-plugin&limit=5",
      "GET /api/v1/search?q=calendar&limit=5",
    ]),
  );
}, 30_000);
