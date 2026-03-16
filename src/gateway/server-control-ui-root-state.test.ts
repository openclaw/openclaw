import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const {
  ensureControlUiAssetsBuiltMock,
  isPackageProvenControlUiRootSyncMock,
  resolveControlUiRootOverrideSyncMock,
  resolveControlUiRootSyncMock,
} = vi.hoisted(() => ({
  ensureControlUiAssetsBuiltMock: vi.fn(),
  isPackageProvenControlUiRootSyncMock: vi.fn(),
  resolveControlUiRootOverrideSyncMock: vi.fn(),
  resolveControlUiRootSyncMock: vi.fn(),
}));

vi.mock("../infra/control-ui-assets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/control-ui-assets.js")>();
  return {
    ...actual,
    ensureControlUiAssetsBuilt: ensureControlUiAssetsBuiltMock,
    isPackageProvenControlUiRootSync: isPackageProvenControlUiRootSyncMock,
    resolveControlUiRootOverrideSync: resolveControlUiRootOverrideSyncMock,
    resolveControlUiRootSync: resolveControlUiRootSyncMock,
  };
});

const { resolveGatewayControlUiRootState } = await import("./server-control-ui-root-state.js");

function createParams(
  overrides: Partial<Parameters<typeof resolveGatewayControlUiRootState>[0]> = {},
) {
  return {
    controlUiEnabled: true,
    controlUiRootOverride: undefined,
    gatewayRuntime: { log: vi.fn<(message: string) => void>() } as unknown as RuntimeEnv,
    log: { warn: vi.fn<(message: string) => void>() },
    runtimePathContext: {
      moduleUrl: "file:///tmp/server.impl.js",
      argv1: "/tmp/server.js",
      cwd: "/tmp",
    },
    ...overrides,
  };
}

afterEach(() => {
  ensureControlUiAssetsBuiltMock.mockReset();
  isPackageProvenControlUiRootSyncMock.mockReset();
  resolveControlUiRootOverrideSyncMock.mockReset();
  resolveControlUiRootSyncMock.mockReset();
});

describe("resolveGatewayControlUiRootState", () => {
  it("returns invalid override and warns when override root is missing", async () => {
    resolveControlUiRootOverrideSyncMock.mockReturnValue(null);
    const params = createParams({ controlUiRootOverride: "./missing-ui" });

    const result = await resolveGatewayControlUiRootState(params);

    expect(result).toEqual({ kind: "invalid", path: expect.stringMatching(/missing-ui$/) });
    expect(params.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("gateway: controlUi.root not found"),
    );
    expect(ensureControlUiAssetsBuiltMock).not.toHaveBeenCalled();
  });

  it("returns resolved override when override root exists", async () => {
    resolveControlUiRootOverrideSyncMock.mockReturnValue("/tmp/ui");
    const params = createParams({ controlUiRootOverride: "./ui" });

    const result = await resolveGatewayControlUiRootState(params);

    expect(result).toEqual({ kind: "resolved", path: "/tmp/ui" });
    expect(params.log.warn).not.toHaveBeenCalled();
  });

  it("builds and retries auto root resolution when first lookup misses", async () => {
    resolveControlUiRootSyncMock.mockReturnValueOnce(undefined).mockReturnValueOnce("/tmp/ui-dist");
    ensureControlUiAssetsBuiltMock.mockResolvedValue({
      ok: false,
      built: false,
      message: "build failed",
    });
    isPackageProvenControlUiRootSyncMock.mockReturnValue(false);
    const params = createParams();

    const result = await resolveGatewayControlUiRootState(params);

    expect(ensureControlUiAssetsBuiltMock).toHaveBeenCalledWith(params.gatewayRuntime);
    expect(params.log.warn).toHaveBeenCalledWith("gateway: build failed");
    expect(isPackageProvenControlUiRootSyncMock).toHaveBeenCalledWith(
      "/tmp/ui-dist",
      params.runtimePathContext,
    );
    expect(result).toEqual({ kind: "resolved", path: "/tmp/ui-dist" });
  });

  it("returns missing when auto root cannot be resolved", async () => {
    resolveControlUiRootSyncMock.mockReturnValue(undefined);
    ensureControlUiAssetsBuiltMock.mockResolvedValue({ ok: true, built: false });
    const params = createParams();

    const result = await resolveGatewayControlUiRootState(params);

    expect(result).toEqual({ kind: "missing" });
  });

  it("returns bundled when package provenance check passes", async () => {
    resolveControlUiRootSyncMock.mockReturnValue("/tmp/ui-dist");
    isPackageProvenControlUiRootSyncMock.mockReturnValue(true);
    const params = createParams();

    const result = await resolveGatewayControlUiRootState(params);

    expect(result).toEqual({ kind: "bundled", path: "/tmp/ui-dist" });
    expect(ensureControlUiAssetsBuiltMock).not.toHaveBeenCalled();
  });

  it("returns undefined when control ui is disabled and no override is provided", async () => {
    const params = createParams({ controlUiEnabled: false });

    const result = await resolveGatewayControlUiRootState(params);

    expect(result).toBeUndefined();
    expect(resolveControlUiRootSyncMock).not.toHaveBeenCalled();
  });
});
