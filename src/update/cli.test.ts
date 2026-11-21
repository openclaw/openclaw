import { afterEach, expect, it, vi } from "vitest";
import { validateUpdateRunParams } from "../../packages/gateway-protocol/src/index.js";

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock("../infra/update-install-status.js", () => ({
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
vi.mock("../gateway/call.js", () => ({
  isGatewayTransportError: () => false,
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

it("sends a pinned commit that the Gateway protocol accepts", async () => {
  const { runReleaseUpdateCli } = await import("./cli.js");
  const sha = "a".repeat(40);
  await expect(
    runReleaseUpdateCli({ json: true, restart: true, runningRoot: "/tmp/openclaw-checkout", sha }),
  ).rejects.toThrow("refused for the test");
  expect(sent).toEqual([{ target: { kind: "git", upstreamRef: "origin/main", upstreamSha: sha } }]);
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
