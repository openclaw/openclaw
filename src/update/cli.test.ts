import { afterEach, expect, it, vi } from "vitest";
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
      git: { upstream: "origin/main" },
    },
    installReceipt: null,
  }),
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

afterEach(() => {
  sent.length = 0;
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
