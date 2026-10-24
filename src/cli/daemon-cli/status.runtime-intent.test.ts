import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveNodeService } from "../../daemon/node-service.js";
import {
  readDaemonRuntimePin,
  readDaemonRuntimePinMigrationPending,
} from "../../daemon/runtime-pin-state.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as systemdDefinition from "../../daemon/systemd-definition-mutation.js";
import { inspectServiceRuntimeIntent } from "./status.runtime-intent.js";

vi.mock("../../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/runtime-pin-state.js")>()),
  readDaemonRuntimePin: vi.fn(),
  readDaemonRuntimePinMigrationPending: vi.fn(() => false),
}));

const service = createMockGatewayService();
const params = {
  kind: "gateway" as const,
  service,
  command: { programArguments: ["/managed/node", "/managed/openclaw/dist/entry.js"] },
  env: { HOME: "/fixture" },
  serviceEnv: { HOME: "/fixture", OPENCLAW_CONFIG_PATH: "/fixture/profile.json" },
  inspectionKnown: true,
};

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.mocked(readDaemonRuntimePin).mockReset().mockReturnValue({ revision: "empty", stored: false });
  service.readDefinitionMutationCapability = vi.fn().mockResolvedValue({ kind: "writable" });
});
afterEach(() => vi.restoreAllMocks());

it.each(["gateway", "node"] as const)(
  "keeps private values out of %s revisions while observing public service identity",
  async (kind) => {
    const capability = vi
      .spyOn(systemdDefinition, "readSystemdDefinitionMutationCapability")
      .mockResolvedValue({ kind: "writable" });
    const inspect = (password: string, profile = "work") =>
      inspectServiceRuntimeIntent({
        ...params,
        kind,
        service: kind === "node" ? resolveNodeService() : service,
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
    expect(readDaemonRuntimePin).toHaveBeenCalledWith(
      { kind, env: params.serviceEnv },
      expect.any(Object),
    );
    if (kind === "node") {
      const identity = { OPENCLAW_SERVICE_KIND: "node", OPENCLAW_SYSTEMD_UNIT: "openclaw-node" };
      expect(capability).toHaveBeenCalledWith(
        expect.objectContaining({ ...params.env, ...identity }),
        expect.objectContaining({
          environment: expect.objectContaining({ ...params.serviceEnv, ...identity }),
        }),
      );
    }
  },
);

it("does not turn malformed or stale pin records into absence", async () => {
  vi.mocked(readDaemonRuntimePin).mockImplementation(() => {
    throw new Error("stale pin");
  });
  expect(await inspectServiceRuntimeIntent(params)).toEqual({
    runtimeIntent: { status: "unknown", error: "stale pin" },
  });
});

it("reports pending migration without reading a pin or claiming it is unpinned", async () => {
  vi.mocked(readDaemonRuntimePinMigrationPending).mockReturnValueOnce(true);
  expect(await inspectServiceRuntimeIntent(params)).toEqual({
    runtimeIntent: { status: "migrationPending", nextStep: "run openclaw doctor" },
  });
  expect(readDaemonRuntimePin).not.toHaveBeenCalled();
});
