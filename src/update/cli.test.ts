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
vi.mock("../gateway/call.js", () => ({
  isGatewayTransportError: () => false,
  callGateway: async (request: { method: string; params: unknown }) => {
    if (request.method === "update.run") {
      sent.push(request.params);
      return { runId: null, ok: false, message: "refused for the test" };
    }
    throw new Error(`unexpected ${request.method}`);
  },
}));

afterEach(() => {
  sent.length = 0;
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
