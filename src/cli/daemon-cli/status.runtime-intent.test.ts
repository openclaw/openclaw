import { beforeEach, expect, it, vi } from "vitest";
import { readDaemonRuntimePin } from "../../daemon/runtime-pin-state.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { isCurrentRuntimeSupported } from "../../infra/runtime-guard.js";
import { inspectCliRuntime, inspectServiceRuntimeIntent } from "./status.runtime-intent.js";

vi.mock("../../daemon/runtime-pin-state.js", () => ({ readDaemonRuntimePin: vi.fn() }));
vi.mock("../../infra/runtime-guard.js", () => ({ isCurrentRuntimeSupported: vi.fn() }));

const service = createMockGatewayService();
const params = {
  service,
  command: { programArguments: ["/managed/node", "/managed/openclaw/dist/entry.js"] },
  env: { HOME: "/fixture" },
  serviceEnv: { HOME: "/fixture", OPENCLAW_CONFIG_PATH: "/fixture/profile.json" },
  inspectionKnown: true,
};

beforeEach(() => {
  vi.mocked(isCurrentRuntimeSupported).mockReset().mockResolvedValue(true);
  vi.mocked(readDaemonRuntimePin).mockReset().mockReturnValue({ revision: "empty", stored: false });
  service.readDefinitionMutationCapability = vi.fn().mockResolvedValue({ kind: "writable" });
});

it.each([true, false])(
  "reports canonical runtime admission=%s and the actual executable",
  async (supported) => {
    vi.mocked(isCurrentRuntimeSupported).mockResolvedValue(supported);
    expect(await inspectCliRuntime()).toEqual({
      kind: process.versions.bun ? "bun" : "node",
      execPath: process.execPath,
      supported,
    });
    expect(isCurrentRuntimeSupported).toHaveBeenCalledOnce();
  },
);

it("retains stored intent even when its service definition is absent", async () => {
  vi.mocked(readDaemonRuntimePin).mockReturnValue({ revision: "retained", stored: true });
  const result = await inspectServiceRuntimeIntent({ ...params, command: null });
  expect(result).toMatchObject({
    runtimeIntent: { status: "known", revision: "retained", stored: true },
    definitionMutation: "writable",
  });
  expect(readDaemonRuntimePin).toHaveBeenCalledWith(
    { kind: "gateway", env: params.serviceEnv },
    null,
  );
});

it("keeps private values out of revisions while observing public service identity", async () => {
  const inspect = (password: string, profile = "work") =>
    inspectServiceRuntimeIntent({
      ...params,
      command: {
        ...params.command,
        environment: { OPENCLAW_GATEWAY_PASSWORD: password, OPENCLAW_PROFILE: profile },
        managedDefinition: {
          ...params.command,
          environment: { OPENCLAW_GATEWAY_PASSWORD: password },
        },
      },
    });
  const before = await inspect("synthetic-old-password");
  const after = await inspect("synthetic-new-password");
  expect(before).toEqual(after);
  expect(await inspect("synthetic-new-password", "personal")).not.toEqual(after);
  expect(JSON.stringify([before, after])).not.toContain("synthetic-");
});

it("reports sealed definitions without granting migration authority", async () => {
  service.readDefinitionMutationCapability = vi.fn().mockResolvedValue({ kind: "sealed" });
  expect(await inspectServiceRuntimeIntent(params)).toMatchObject({ definitionMutation: "sealed" });
});

it("does not read runtime intent after failed service inspection", async () => {
  expect(await inspectServiceRuntimeIntent({ ...params, inspectionKnown: false })).toEqual({
    runtimeIntent: { status: "unknown" },
  });
  expect(readDaemonRuntimePin).not.toHaveBeenCalled();
});

it("does not turn malformed or stale pin records into absence", async () => {
  vi.mocked(readDaemonRuntimePin).mockImplementation(() => {
    throw new Error("stale pin");
  });
  expect(await inspectServiceRuntimeIntent(params)).toEqual({
    runtimeIntent: { status: "unknown" },
  });
});

it("rejects a pin changed while the service capability was being inspected", async () => {
  vi.mocked(readDaemonRuntimePin)
    .mockReturnValueOnce({ revision: "before", stored: false })
    .mockReturnValueOnce({ revision: "after", stored: true });
  expect(await inspectServiceRuntimeIntent(params)).toEqual({
    runtimeIntent: { status: "unknown" },
  });
});
