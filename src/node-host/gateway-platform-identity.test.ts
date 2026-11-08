import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNodeHostGatewayPlatformIdentity } from "./gateway-platform-identity.js";

const { resolveModel } = vi.hoisted(() => ({
  resolveModel: vi.fn<typeof import("../infra/machine-model.js").resolveMachineModelIdentifier>(),
}));

vi.mock("../infra/machine-model.js", () => ({
  resolveMachineModelIdentifier: resolveModel,
}));

describe("resolveNodeHostGatewayPlatformIdentity", () => {
  beforeEach(() => {
    resolveModel.mockReset();
  });

  it.each([
    { runtime: "darwin", platform: "macos", deviceFamily: "Mac", modelIdentifier: "Mac16,1" },
    { runtime: "linux", platform: "linux", deviceFamily: "Linux", modelIdentifier: "Test Board" },
    { runtime: "win32", platform: "windows", deviceFamily: "Windows", modelIdentifier: undefined },
    {
      runtime: "freebsd",
      platform: "freebsd",
      deviceFamily: undefined,
      modelIdentifier: undefined,
    },
  ] as const)(
    "reports $runtime hardware identity",
    ({ runtime, platform, deviceFamily, modelIdentifier }) => {
      resolveModel.mockReturnValue(modelIdentifier);
      expect(resolveNodeHostGatewayPlatformIdentity(runtime)).toEqual({
        platform,
        ...(deviceFamily ? { deviceFamily, modelIdentifier } : {}),
      });
      expect(resolveModel).toHaveBeenCalledExactlyOnceWith(runtime);
    },
  );
});
