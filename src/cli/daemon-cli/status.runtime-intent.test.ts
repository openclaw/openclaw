import { beforeEach, expect, it, vi } from "vitest";
import { readDaemonRuntimePin } from "../../daemon/runtime-pin-state.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { inspectServiceRuntimeIntent } from "./status.runtime-intent.js";

vi.mock("../../daemon/runtime-pin-state.js", () => ({ readDaemonRuntimePin: vi.fn() }));

const service = createMockGatewayService();
const params = {
  service,
  command: { programArguments: ["/managed/node", "/managed/openclaw/dist/entry.js"] },
  env: { HOME: "/fixture" },
  serviceEnv: { HOME: "/fixture", OPENCLAW_CONFIG_PATH: "/fixture/profile.json" },
  inspectionKnown: true,
};

beforeEach(() => {
  vi.mocked(readDaemonRuntimePin).mockReset().mockReturnValue({ revision: "empty", stored: false });
  service.readDefinitionMutationCapability = vi.fn().mockResolvedValue({ kind: "writable" });
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
