import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const {
  ensureControlUiAssetsBuiltMock,
  isPackageProvenControlUiRootSyncMock,
  resolveControlUiRepoRootFromDistRootMock,
  resolveControlUiRootOverrideSyncMock,
  resolveControlUiRootSyncMock,
} = vi.hoisted(() => ({
  ensureControlUiAssetsBuiltMock: vi.fn(),
  isPackageProvenControlUiRootSyncMock: vi.fn(),
  resolveControlUiRepoRootFromDistRootMock: vi.fn(),
  resolveControlUiRootOverrideSyncMock: vi.fn(),
  resolveControlUiRootSyncMock: vi.fn(),
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt: ensureControlUiAssetsBuiltMock,
  isPackageProvenControlUiRootSync: isPackageProvenControlUiRootSyncMock,
  resolveControlUiRepoRootFromDistRoot: resolveControlUiRepoRootFromDistRootMock,
  resolveControlUiRootOverrideSync: resolveControlUiRootOverrideSyncMock,
  resolveControlUiRootSync: resolveControlUiRootSyncMock,
}));

const { resolveGatewayControlUiRootState } = await import("./server-control-ui-root.js");

const runtime = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
} satisfies RuntimeEnv;

function createLog() {
  return { warn: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureControlUiAssetsBuiltMock.mockResolvedValue({ ok: true, built: true });
  isPackageProvenControlUiRootSyncMock.mockReturnValue(true);
  resolveControlUiRepoRootFromDistRootMock.mockReturnValue(null);
  resolveControlUiRootOverrideSyncMock.mockReturnValue(null);
  resolveControlUiRootSyncMock.mockReturnValue(null);
});

describe("resolveGatewayControlUiRootState", () => {
  it("auto-builds missing configured roots that point at the default repo Control UI dist", async () => {
    const repoRoot = path.resolve("fixtures/openclaw-source");
    const configuredRoot = path.join(repoRoot, "dist", "control-ui");
    const log = createLog();

    resolveControlUiRepoRootFromDistRootMock.mockReturnValue(repoRoot);
    resolveControlUiRootOverrideSyncMock
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(configuredRoot);

    await expect(
      resolveGatewayControlUiRootState({
        controlUiEnabled: true,
        controlUiRootOverride: configuredRoot,
        gatewayRuntime: runtime,
        log,
      }),
    ).resolves.toEqual({ kind: "resolved", path: configuredRoot });

    expect(ensureControlUiAssetsBuiltMock).toHaveBeenCalledWith(runtime, { repoRoot });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not build arbitrary missing configured roots", async () => {
    const configuredRoot = path.resolve("fixtures/custom-control-ui");
    const log = createLog();

    await expect(
      resolveGatewayControlUiRootState({
        controlUiEnabled: true,
        controlUiRootOverride: configuredRoot,
        gatewayRuntime: runtime,
        log,
      }),
    ).resolves.toEqual({ kind: "invalid", path: configuredRoot });

    expect(ensureControlUiAssetsBuiltMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(`gateway: controlUi.root not found at ${configuredRoot}`);
  });
});
