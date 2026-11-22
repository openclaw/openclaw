import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateUpdateRunParams } from "../../packages/gateway-protocol/src/index.js";

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock("../infra/update-install-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-install-status.js")>()),
  resolveStartupInstallStatus: async () => ({
    root: "/tmp/openclaw-checkout",
    status: {
      root: "/tmp/openclaw-checkout",
      installKind: "git",
      packageManager: "pnpm",
      git: { upstream: "origin/main", tag: "v2026.11.6", branch: null },
    },
    installReceipt: null,
  }),
}));
const prepared = vi.hoisted(() => [] as unknown[]);
// mock-isolation: preparation builds a real release; this test checks only the channel it is given.
vi.mock("./run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run.js")>()),
  prepareUpdate: async (params: unknown) => {
    prepared.push(params);
    return { status: "current", version: "2026.11.6", pluginsChanged: false };
  },
}));
vi.mock("../infra/update-run-write.async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-write.async.js")>()),
  createUpdateRunAsync: async () => ({ runId: "run-cli" }),
}));
vi.mock("../infra/update-run-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-reader.js")>()),
  getUpdateRunAsync: async () => ({
    status: "skipped",
    reason: "already-current",
    phase: "finished",
    steps: [],
    after: {},
    origin: {},
  }),
}));
const converted = vi.hoisted(() => [] as unknown[]);
// mock-isolation: conversion builds a release and restarts the service; this checks the routing.
vi.mock("./half-switched.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./half-switched.js")>()),
  convertHalfSwitchedCheckout: async (params: unknown) => {
    converted.push(params);
    return "run-converted";
  },
}));
const runsGet = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: async (request: { method: string; params: unknown }) => {
    if (request.method === "update.run") {
      sent.push(request.params);
      return runsGet.length
        ? { runId: "run-1", ok: true }
        : { runId: null, ok: false, message: "refused for the test" };
    }
    if (request.method === "update.runs.get" && runsGet.length) {
      return runsGet.shift()!();
    }
    throw new Error(`unexpected ${request.method}`);
  },
}));

// Every case reads release state; none may see the developer's own state directory.
let stateDir: string;
beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-release-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(stateDir, { recursive: true, force: true });
  sent.length = 0;
  prepared.length = 0;
  converted.length = 0;
  runsGet.length = 0;
  process.exitCode = undefined;
});

it("sends a pinned commit and the --timeout budget that the Gateway protocol accepts", async () => {
  const { runReleaseUpdateCli } = await import("./cli.js");
  const sha = "a".repeat(40);
  await expect(
    runReleaseUpdateCli({
      json: true,
      restart: true,
      runningRoot: "/tmp/openclaw-checkout",
      sha,
      timeoutMs: 5_000,
    }),
  ).rejects.toThrow("refused for the test");
  expect(sent).toEqual([
    { target: { kind: "git", upstreamRef: "origin/main", upstreamSha: sha }, timeoutMs: 5_000 },
  ]);
  expect(validateUpdateRunParams(sent[0])).toBe(true);
});

it("keeps a stable-tag checkout on stable when it updates without the Gateway", async () => {
  const { runReleaseUpdateCli } = await import("./cli.js");
  await runReleaseUpdateCli({ json: true, restart: false, runningRoot: "/tmp/openclaw-checkout" });
  expect(prepared).toEqual([expect.objectContaining({ channel: "stable" })]);
});

it("prepares this checkout itself instead of updating a remote Gateway", async () => {
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://remote.example.invalid");
  const { runReleaseUpdateCli } = await import("./cli.js");
  await runReleaseUpdateCli({ json: true, restart: true, runningRoot: "/tmp/openclaw-checkout" });
  expect(sent).toEqual([]);
  expect(prepared).toEqual([expect.objectContaining({ runningRoot: "/tmp/openclaw-checkout" })]);
});

it("keeps following the run while the restarting Gateway refuses connections", async () => {
  const { GatewayClientRequestError } = await import("../gateway/client.js");
  const { runReleaseUpdateCli } = await import("./cli.js");
  runsGet.push(
    () => {
      throw new GatewayClientRequestError({
        code: "UNAVAILABLE",
        retryable: true,
        message:
          "gateway rejected websocket upgrade (HTTP 503): Gateway websocket admission closed",
      });
    },
    () => ({
      run: {
        status: "succeeded",
        phase: "finished",
        steps: [],
        after: { version: "2.0.0" },
        origin: {},
      },
    }),
  );
  await runReleaseUpdateCli({ json: true, restart: true, runningRoot: "/tmp/openclaw-checkout" });
  expect(process.exitCode).toBe(0);
});

it("says the update is still running when the --timeout budget ends first", async () => {
  const { defaultRuntime } = await import("../runtime.js");
  const { runReleaseUpdateCli } = await import("./cli.js");
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  runsGet.push(() => ({
    run: { status: "running", phase: "staging", steps: [], after: {}, origin: {} },
  }));
  await runReleaseUpdateCli({
    json: false,
    restart: true,
    runningRoot: "/tmp/openclaw-checkout",
    timeoutMs: 100,
  });
  expect(error.mock.calls.map(([message]) => message)).toEqual([
    "The update did not finish in time. Run `openclaw update status` to see it.",
  ]);
  expect(process.exitCode).toBe(1);
});

it("finishes a half-switched checkout itself instead of asking the Gateway that left it so", async () => {
  // The #199706 updater's trial: no format field, a release under lib/node_modules.
  await fs.mkdir(path.join(stateDir, "git-install", "releases"), { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "git-install", "releases", ".trial"),
    JSON.stringify({ target: "../../releases/x/lib/node_modules/openclaw", previous: "y" }),
  );
  runsGet.push(() => ({
    run: { status: "succeeded", phase: "finished", steps: [], after: {}, origin: {} },
  }));
  const { runReleaseUpdateCli } = await import("./cli.js");
  await runReleaseUpdateCli({ json: true, restart: true, runningRoot: "/tmp/openclaw-release" });
  expect(sent).toEqual([]);
  expect(converted).toEqual([
    expect.objectContaining({ runningRoot: "/tmp/openclaw-release", channel: "dev" }),
  ]);
  expect(process.exitCode).toBe(0);
});
