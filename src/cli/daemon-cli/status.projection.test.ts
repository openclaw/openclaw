import { expect, it, vi } from "vitest";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { VERSION } from "../../version.js";
import { projectDaemonRuntimeStatus } from "./status.projection.js";

const inspection = vi.hoisted(() => ({
  loaded: vi.fn(),
  cli: vi.fn().mockResolvedValue({ kind: "node", execPath: "/fixture/node", supported: true }),
  service: vi
    .fn()
    .mockResolvedValue({ runtimeIntent: { status: "known", stored: false, revision: "empty" } }),
}));

vi.mock("./status.runtime-intent.js", () => {
  inspection.loaded();
  return { inspectCliRuntime: inspection.cli, inspectServiceRuntimeIntent: inspection.service };
});

it("keeps fast status lazy and preserves the deep runtime projections", async () => {
  const params = {
    service: createMockGatewayService(),
    state: {
      command: {
        programArguments: ["/fixture/node", "/fixture/entry.js"],
        environment: { OPENCLAW_PROFILE: "work" },
      },
      loadState: { status: "not-loaded" as const },
    },
    env: { HOME: "/fixture", OPENCLAW_PROFILE: "caller" },
    argv: ["/fixture/node", " /fixture/entry.js "],
  };
  expect(await projectDaemonRuntimeStatus(params)).toEqual({
    cli: { version: VERSION, entrypoint: "/fixture/entry.js" },
  });
  expect(inspection.loaded).not.toHaveBeenCalled();
  expect(await projectDaemonRuntimeStatus({ ...params, deep: true })).toEqual({
    cli: {
      version: VERSION,
      entrypoint: "/fixture/entry.js",
      runtime: { kind: "node", execPath: "/fixture/node", supported: true },
    },
    runtimeIntent: { runtimeIntent: { status: "known", stored: false, revision: "empty" } },
  });
  expect(inspection.service).toHaveBeenCalledWith({
    service: params.service,
    command: params.state.command,
    env: params.env,
    serviceEnv: { HOME: "/fixture", OPENCLAW_PROFILE: "work" },
    inspectionKnown: true,
  });
  expect(inspection.cli).toHaveBeenCalledOnce();
});
