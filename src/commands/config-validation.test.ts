import { beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileSnapshot = vi.fn();
const buildPluginCompatibilityNotices = vi.fn(() => []);

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilityNotices,
  formatPluginCompatibilityNotice: (notice: { pluginId: string; message: string }) =>
    `${notice.pluginId} ${notice.message}`,
}));

describe("requireValidConfigSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns config and emits a non-blocking compatibility advisory", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { plugins: {} },
      issues: [],
    });
    buildPluginCompatibilityNotices.mockReturnValue([
      {
        pluginId: "legacy-plugin",
        code: "legacy-before-agent-start",
        severity: "warn",
        message:
          "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
      },
    ]);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const { requireValidConfigSnapshot } = await import("./config-validation.js");
    const config = await requireValidConfigSnapshot(runtime);

    expect(config).toEqual({ plugins: {} });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(String(runtime.log.mock.calls[0]?.[0])).toContain("Plugin compatibility: 1 notice.");
    expect(String(runtime.log.mock.calls[0]?.[0])).toContain(
      "legacy-plugin still uses legacy before_agent_start",
    );
  });

  it("blocks invalid config before emitting compatibility advice", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      issues: [{ path: "routing.allowFrom", message: "Legacy key" }],
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const { requireValidConfigSnapshot } = await import("./config-validation.js");
    const config = await requireValidConfigSnapshot(runtime);

    expect(config).toBeNull();
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
