import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
  listBundledChannelPlugins: vi.fn(),
}));

vi.mock("../../../channels/plugins/registry.js", () => ({
  listChannelPlugins: (...args: Parameters<typeof mocks.listChannelPlugins>) =>
    mocks.listChannelPlugins(...args),
}));

vi.mock("../../../channels/plugins/bundled.js", () => ({
  listBundledChannelPlugins: (...args: Parameters<typeof mocks.listBundledChannelPlugins>) =>
    mocks.listBundledChannelPlugins(...args),
}));

let collectChannelDoctorCompatibilityMutations: typeof import("./channel-doctor.js").collectChannelDoctorCompatibilityMutations;

describe("channel doctor compatibility mutations", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ collectChannelDoctorCompatibilityMutations } = await import("./channel-doctor.js"));
    mocks.listChannelPlugins.mockReset();
    mocks.listBundledChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.listBundledChannelPlugins.mockReturnValue([]);
  });

  it("skips plugin discovery when no channels are configured", () => {
    const result = collectChannelDoctorCompatibilityMutations({} as never);

    expect(result).toEqual([]);
    expect(mocks.listChannelPlugins).not.toHaveBeenCalled();
    expect(mocks.listBundledChannelPlugins).not.toHaveBeenCalled();
  });

  it("only evaluates configured channel ids", () => {
    const normalizeCompatibilityConfig = vi.fn(({ cfg }: { cfg: unknown }) => ({
      config: cfg,
      changes: ["matrix"],
    }));
    mocks.listBundledChannelPlugins.mockReturnValue([
      {
        id: "matrix",
        doctor: { normalizeCompatibilityConfig },
      },
      {
        id: "discord",
        doctor: {
          normalizeCompatibilityConfig: vi.fn(() => ({
            config: {},
            changes: ["discord"],
          })),
        },
      },
    ]);

    const cfg = {
      channels: {
        matrix: {
          enabled: true,
        },
      },
    };

    const result = collectChannelDoctorCompatibilityMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
    expect(mocks.listBundledChannelPlugins).toHaveBeenCalledTimes(1);
  });
});
