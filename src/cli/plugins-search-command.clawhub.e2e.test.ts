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
import { runPluginsSearchCommand } from "./plugins-search-command.js";

type FixtureServer = { child: ChildProcess; closed: Promise<void> };
const servers: FixtureServer[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await Promise.all(servers.splice(0).map(stopServer));
  vi.unstubAllEnvs();
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
  const child = spawn(
    process.execPath,
    ["scripts/e2e/lib/clawhub-fixture-server.cjs", "catalog-search", path.join(root, "port")],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
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
    const error = `fixture server did not write a port: ${stderr}`;
    assert(typeof message === "object" && message !== null && "port" in message, error);
    assert(
      typeof message.port === "number" && Number.isInteger(message.port) && message.port > 0,
      error,
    );
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

async function search(query: string, json = false) {
  const runtime = {
    log: vi.fn<RuntimeEnv["log"]>(),
    error: vi.fn<RuntimeEnv["error"]>(),
    exit: vi.fn<RuntimeEnv["exit"]>(),
  };
  await runPluginsSearchCommand(query, { limit: 5, json }, runtime);
  return runtime;
}

function output(runtime: Awaited<ReturnType<typeof search>>, stream: "log" | "error" = "log") {
  return runtime[stream].mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

it("keeps plugin discovery separate from skills and surfaces empty and failed lookups", async ({
  signal,
}) => {
  const { baseUrl, root } = await startFixtureServer(signal);
  vi.stubEnv("OPENCLAW_CLAWHUB_URL", baseUrl);
  vi.stubEnv("CLAWHUB_CONFIG_PATH", path.join(root, "missing-config.json"));
  vi.stubEnv("CLAWHUB_TOKEN", undefined);
  vi.stubEnv("CLAWHUB_AUTH_TOKEN", undefined);

  const terminal = await search("calendar");
  const terminalOutput = output(terminal);
  expect(terminal.exit).not.toHaveBeenCalled();
  expect(terminalOutput.match(/^@acme\/calendar {2}/gm)).toHaveLength(1);
  expect(terminalOutput).toContain("bundle-plugin | official | v3.0.0");
  expect(terminalOutput).toContain("Install: openclaw plugins install @acme/calendar");
  expect(terminalOutput).not.toContain("calendar-skill");

  const json = await search("calendar", true);
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

  const skills = await searchSkillsFromClawHub({ query: "calendar", limit: 5 });
  expect(skills).toEqual([expect.objectContaining({ score: 99, slug: "calendar-skill" })]);

  const empty = await search("empty");
  expect(empty.exit).not.toHaveBeenCalled();
  expect(empty.log.mock.calls).toEqual([["No ClawHub plugins found."]]);

  const unavailable = await search("unavailable");
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
