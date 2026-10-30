import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeEnv } from "../runtime.js";
import { searchSkillsFromClawHub } from "../skills/lifecycle/clawhub.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { runPluginsSearchCommand } from "./plugins-search-command.js";

const servers: Array<() => Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
  vi.unstubAllEnvs();
});

async function startFixtureServer(signal: AbortSignal) {
  const root = tempDirs.make("clawhub-search-e2e-");
  const reservation = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const query = url.searchParams.get("q");
        const family = url.searchParams.get("family");
        const packages = url.pathname === "/api/v1/packages/search";
        if (
          request.method !== "GET" ||
          (!packages && url.pathname !== "/api/v1/search") ||
          (packages && family !== "code-plugin" && family !== "bundle-plugin")
        ) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(query === "unavailable" ? 503 : 200, {
          "content-type": "application/json",
        });
        const results =
          query === "empty"
            ? []
            : packages
              ? [
                  {
                    score: family === "bundle-plugin" ? 12 : 4,
                    package: {
                      name: "@acme/calendar",
                      family,
                      channel: "official",
                      isOfficial: true,
                    },
                  },
                ]
              : [{ score: 99, source: "clawhub", ownerHandle: "acme", slug: "calendar-skill" }];
        response.end(
          JSON.stringify(query === "unavailable" ? { error: "catalog unavailable" } : { results }),
        );
      }),
  });
  servers.push(async () => {
    await reservation.releaseListener();
    await reservation.claim.release();
  });
  return { baseUrl: `http://127.0.0.1:${reservation.claim.port}`, root };
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
}, 30_000);
