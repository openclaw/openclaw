import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";

const prepareUpdate = vi.hoisted(() => vi.fn());
vi.mock("../../update/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../update/run.js")>()),
  prepareUpdate,
}));
vi.mock("../../infra/update-install-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-install-status.js")>()),
  resolveStartupInstallStatus: async () => ({
    root: "/tmp/openclaw-checkout",
    status: { root: "/tmp/openclaw-checkout", installKind: "git", packageManager: "pnpm" },
    installReceipt: null,
  }),
}));
// mock-isolation: admission reads the real install owner and process root; this test starts after it.
vi.mock("./update-admission.js", () => ({
  admitGatewayUpdateRequest: async () => ({}),
}));

let lifecycle: UpdateCheckLifecycle;
beforeEach(() => {
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
});
afterEach(async () => {
  await lifecycle.stop();
  vi.unstubAllEnvs();
});

it("refuses before preparing a release when the Gateway may not replace its process", async () => {
  vi.stubEnv("OPENCLAW_NO_RESPAWN", "1");
  const { updateRunHandler } = await import("./update-run.js");
  const respond = vi.fn();
  await updateRunHandler({
    req: { type: "req", id: "1", method: "update.run" },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as unknown as Parameters<typeof updateRunHandler>[0]);
  expect(respond).toHaveBeenCalledOnce();
  expect(respond.mock.calls[0]?.[1]).toMatchObject({
    runId: null,
    ok: false,
    code: "restart-unavailable",
  });
  expect(prepareUpdate).not.toHaveBeenCalled();
});
