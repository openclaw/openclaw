import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const probePath = path.resolve("scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs");
const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());
const LOAD_SENSITIVE_PROCESS_TIMEOUT_MS = process.env.CI ? 30_000 : 15_000;
const FIXTURE_URL = "http://probe.test";
const outputPath = (name: string) =>
  path.join(lifetime.createTempDir("openclaw-upgrade-probe-"), name);

function writeProbeImport(source: string): string[] {
  const fixturePath = outputPath("probe-import.mjs");
  fs.writeFileSync(fixturePath, source);
  return ["--import", pathToFileURL(fixturePath).href];
}

function probeArgs(
  baseUrl: string,
  out: string,
  kind: "ready" | "started" | "live" = "ready",
  timeout = 1000,
  extra: string[] = [],
) {
  const route = { ready: "/readyz", started: "/startupz", live: "/healthz" }[kind];
  return [
    "--base-url",
    baseUrl,
    "--path",
    route,
    "--expect",
    kind,
    "--out",
    out,
    "--timeout-ms",
    String(timeout),
    ...extra,
  ];
}

// Advance only retry sleeps; transport deadlines still use real timers.
function virtualFetch(body: string, status: string, delay: number) {
  return writeProbeImport(
    [
      "const realSetTimeout = globalThis.setTimeout;",
      "let now = 0, calls = 0;",
      "Date.now = () => now;",
      `globalThis.fetch = async () => new Response(JSON.stringify(${body}), { status: ${status}, headers: { "content-type": "application/json" } });`,
      "globalThis.setTimeout = (callback, delay = 0, ...args) => {",
      `  if (delay === ${delay}) { now += delay; return realSetTimeout(callback, 0, ...args); }`,
      "  return realSetTimeout(callback, delay, ...args);",
      "};",
    ].join("\n"),
  );
}

async function runProbe(
  signal: AbortSignal,
  args: string[],
  timeout = LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = {},
  nodeArgs: string[] = [],
  onReady?: (child: ChildProcess) => void,
) {
  let exitSignal: NodeJS.Signals | null = null;
  const result = await lifetime.track(
    runNodeScript([...nodeArgs, probePath, ...args], { ...process.env, ...env }, timeout, {
      signal,
      executable: process.execPath,
      onReady(child) {
        child.once("exit", (_status, nativeSignal) => {
          exitSignal = nativeSignal;
        });
        onReady?.(child);
      },
    }),
  );
  return { ...result, signal: exitSignal };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

it("drains stderr after process exit before publishing the probe result", ({ signal }) =>
  lifetime.run(async () => {
    let exitObserved:
      | { status: number | null; signal: NodeJS.Signals | null; stderrPaused: boolean }
      | undefined;
    const result = await runProbe(
      signal,
      ["--timeout-ms", "1e3"],
      LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
      {},
      [],
      (child) => {
        child.stderr?.pause();
        child.once("exit", (status, nativeSignal) => {
          exitObserved = {
            status,
            signal: nativeSignal,
            stderrPaused: child.stderr?.isPaused() === true,
          };
          child.stderr?.resume();
        });
      },
    );

    expect(exitObserved).toEqual({ status: 1, signal: null, stderrPaused: true });
    expect(result).toMatchObject({ status: 1, signal: null, error: undefined });
    expect(result.stderr).toContain("invalid --timeout-ms: 1e3");
  }));

it("writes a result when the ready probe matches", ({ signal }) =>
  lifetime.run(async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready: true }));
    });
    const baseUrl = await listen(server);
    const out = outputPath("ready.json");
    try {
      const result = await runProbe(signal, probeArgs(baseUrl, out));

      expect(result.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({
        body: { ready: true },
        path: "/readyz",
        status: 200,
        url: `${baseUrl}/readyz`,
      });
    } finally {
      server.close();
    }
  }));

it("waits for startup completion even when required-agent readiness is already true", ({
  signal,
}) =>
  lifetime.run(async () => {
    const out = outputPath("startup.json");
    const nodeArgs = virtualFetch(
      '++calls === 1 ? { ready: true, ok: false, status: "starting", pendingReason: "agent-database-inspection" } : { ok: true, status: "started" }',
      "calls === 1 ? 503 : 200",
      100,
    );
    const result = await runProbe(
      signal,
      probeArgs(FIXTURE_URL, out, "started"),
      LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
      {},
      nodeArgs,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({
      body: { ok: true, status: "started" },
      path: "/startupz",
      status: 200,
      elapsedMs: 100,
    });
  }));

it("rejects degraded ready responses by default even when failing components are allowlisted", ({
  signal,
}) =>
  lifetime.run(async () => {
    const out = outputPath("ready-degraded.json");
    const nodeArgs = virtualFetch('{ ready: false, failing: ["telegram"] }', "503", 50);
    const result = await runProbe(
      signal,
      probeArgs(FIXTURE_URL, out, "ready", 50, [
        "--allow-failing",
        "telegram",
        "--attempt-timeout-ms",
        "25",
      ]),
      LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
      { OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED: "0" },
      nodeArgs,
    );

    expect(result).toMatchObject({ status: 1, signal: null, error: undefined });
    expect(result.stderr).toContain("probe failed with HTTP 503");
    expect(fs.existsSync(out)).toBe(false);
  }));

it.for(["ready", "started"] as const)(
  "keeps failed %s probe retries inside the total timeout",
  (expectKind, { signal }) =>
    lifetime.run(async () => {
      const out = outputPath("ready-timeout.json");
      const nodeArgs = virtualFetch('{ ready: false, failing: ["gateway"] }', "503", 50);
      const result = await runProbe(
        signal,
        probeArgs(FIXTURE_URL, out, expectKind, 50, ["--attempt-timeout-ms", "25"]),
        LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
        {},
        nodeArgs,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`probe did not satisfy ${expectKind} within 50ms`);
      expect(fs.existsSync(out)).toBe(false);
    }),
);

it("does not let degraded ready mode convert generic server errors into success", ({ signal }) =>
  lifetime.run(async () => {
    const out = outputPath("ready-server-error.json");
    const nodeArgs = writeProbeImport(
      'globalThis.fetch = async () => new Response(JSON.stringify({ ready: true }), { status: 500, headers: { "content-type": "application/json" } });',
    );
    const result = await runProbe(
      signal,
      probeArgs(FIXTURE_URL, out, "ready", 300, [
        "--allow-failing",
        "telegram",
        "--allow-degraded-ready",
      ]),
      LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
      {},
      nodeArgs,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("probe failed with HTTP 500");
    expect(fs.existsSync(out)).toBe(false);
  }));

it.for(["connection", "body"])("bounds probes stalled at %s", (stage, { signal }) =>
  lifetime.run(async () => {
    const sockets = new Set<Socket>();
    const server =
      stage === "body"
        ? createHttpServer((_request, response) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.write('{"ok":');
          })
        : createTcpServer((socket) => socket.on("data", () => {}));
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const baseUrl = await listen(server);
    const out = outputPath(`${stage}-stall.json`);
    const startedAt = Date.now();
    try {
      const result = await runProbe(
        signal,
        probeArgs(baseUrl, out, "live", 300, ["--attempt-timeout-ms", "100"]),
      );
      const elapsedMs = Date.now() - startedAt;

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      if (stage === "body") {
        const attemptDeadline = result.stderr.match(/probe attempt timed out after (\d+)ms/u);
        expect(attemptDeadline).not.toBeNull();
        expect(Number(attemptDeadline?.[1])).toBeGreaterThan(0);
        expect(Number(attemptDeadline?.[1])).toBeLessThanOrEqual(100);
      } else {
        expect(result.stderr).toContain("probe did not satisfy live within 300ms");
      }
      expect(elapsedMs).toBeLessThan(2_500);
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    }
  }),
);
