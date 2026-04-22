import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectChannelDoctorCompatibilityMutations,
  collectChannelDoctorEmptyAllowlistExtraWarnings,
} from "./channel-doctor.js";

const mocks = vi.hoisted(() => ({
  getLoadedChannelPlugin: vi.fn(),
  getBundledChannelSetupPlugin: vi.fn(),
  resolveReadOnlyChannelPluginsForConfig: vi.fn(),
}));

vi.mock("../../../channels/plugins/registry.js", () => ({
  getLoadedChannelPlugin: (...args: Parameters<typeof mocks.getLoadedChannelPlugin>) =>
    mocks.getLoadedChannelPlugin(...args),
}));

vi.mock("../../../channels/plugins/bundled.js", () => ({
  getBundledChannelSetupPlugin: (...args: Parameters<typeof mocks.getBundledChannelSetupPlugin>) =>
    mocks.getBundledChannelSetupPlugin(...args),
}));

vi.mock("../../../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: (
    ...args: Parameters<typeof mocks.resolveReadOnlyChannelPluginsForConfig>
  ) => mocks.resolveReadOnlyChannelPluginsForConfig(...args),
}));

describe("channel doctor compatibility mutations", () => {
  beforeEach(() => {
    mocks.getLoadedChannelPlugin.mockReset();
    mocks.getBundledChannelSetupPlugin.mockReset();
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReset();
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);
    mocks.getBundledChannelSetupPlugin.mockReturnValue(undefined);
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({ plugins: [] });
  });

  it("skips plugin discovery when no channels are configured", () => {
    const result = collectChannelDoctorCompatibilityMutations({} as never);

    expect(result).toEqual([]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).not.toHaveBeenCalled();
  });

  it("uses read-only doctor adapters for configured channel ids", () => {
    const normalizeCompatibilityConfig = vi.fn(({ cfg }: { cfg: unknown }) => ({
      config: cfg,
      changes: ["matrix"],
    }));
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [
        {
          id: "matrix",
          doctor: { normalizeCompatibilityConfig },
        },
      ],
    });

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
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
      includePersistedAuthState: false,
    });
    expect(mocks.getLoadedChannelPlugin).not.toHaveBeenCalledWith("matrix");
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalledWith("matrix");
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalledWith("discord");
  });

  it("falls back to setup doctor adapters when read-only plugins lack doctor hooks", () => {
    const normalizeCompatibilityConfig = vi.fn(({ cfg }: { cfg: unknown }) => ({
      config: cfg,
      changes: ["matrix"],
    }));
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [
        {
          id: "matrix",
        },
      ],
    });
    mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) =>
      id === "matrix"
        ? {
            id: "matrix",
            doctor: { normalizeCompatibilityConfig },
          }
        : undefined,
    );

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
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
      includePersistedAuthState: false,
    });
    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("matrix");
    expect(mocks.getBundledChannelSetupPlugin).toHaveBeenCalledWith("matrix");
  });

  it("passes explicit env into read-only channel plugin discovery", () => {
    const cfg = {
      channels: {
        matrix: {
          enabled: true,
        },
      },
    };
    const env = { OPENCLAW_HOME: "/tmp/openclaw-test-home" };

    collectChannelDoctorCompatibilityMutations(cfg as never, { env });

    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
      env,
      includePersistedAuthState: false,
    });
  });

  it("keeps configured channel doctor lookup non-fatal when setup loading fails", () => {
    mocks.resolveReadOnlyChannelPluginsForConfig.mockImplementation(() => {
      throw new Error("missing runtime dep");
    });
    mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) => {
      if (id === "discord") {
        throw new Error("missing runtime dep");
      }
      return undefined;
    });

    const result = collectChannelDoctorCompatibilityMutations({
      channels: {
        discord: {
          enabled: true,
        },
      },
    } as never);

    expect(result).toEqual([]);
    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("discord");
    expect(mocks.getBundledChannelSetupPlugin).toHaveBeenCalledWith("discord");
  });

  it("routes config through empty allowlist extra warning discovery", () => {
    const collectEmptyAllowlistExtraWarnings = vi.fn(({ cfg }: { cfg?: unknown }) =>
      cfg ? ["matrix extra"] : [],
    );
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "allowlist",
        },
      },
    };
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [
        {
          id: "matrix",
          doctor: { collectEmptyAllowlistExtraWarnings },
        },
      ],
    });

    const result = collectChannelDoctorEmptyAllowlistExtraWarnings({
      account: {},
      channelName: "matrix",
      cfg: cfg as never,
      prefix: "channels.matrix",
    });

    expect(result).toEqual(["matrix extra"]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
      includePersistedAuthState: false,
    });
    expect(collectEmptyAllowlistExtraWarnings).toHaveBeenCalledWith(
      expect.objectContaining({ cfg }),
    );
  });
});
