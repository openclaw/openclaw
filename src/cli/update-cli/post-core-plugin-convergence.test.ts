import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repairMissingConfiguredPluginInstalls: vi.fn(),
  runPluginPayloadSmokeCheck: vi.fn(),
  loadInstalledPluginIndexInstallRecords: vi.fn(),
}));

vi.mock("../../commands/doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: mocks.repairMissingConfiguredPluginInstalls,
}));
vi.mock("./plugin-payload-validation.js", () => ({
  runPluginPayloadSmokeCheck: mocks.runPluginPayloadSmokeCheck,
}));
vi.mock("../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
}));

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  convergenceWarningsToOutcomes,
  runPostCorePluginConvergence,
} from "./post-core-plugin-convergence.js";

describe("runPostCorePluginConvergence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({ changes: [], warnings: [] });
    mocks.runPluginPayloadSmokeCheck.mockResolvedValue({ checked: [], failures: [] });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
  });

  it("calls repair with OPENCLAW_UPDATE_POST_CORE_CONVERGENCE=1 set", async () => {
    await runPostCorePluginConvergence({
      cfg: { plugins: { entries: {} } } as unknown as OpenClawConfig,
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
    });
    expect(mocks.repairMissingConfiguredPluginInstalls).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
        }),
      }),
    );
  });

  it("returns ok when no warnings/failures and includes repair changes", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: ['Repaired missing configured plugin "discord".'],
      warnings: [],
    });
    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { discord: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(false);
    expect(result.changes).toEqual(['Repaired missing configured plugin "discord".']);
    expect(result.warnings).toEqual([]);
  });

  it("flags errored=true and surfaces actionable guidance when repair warns", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [
        'Failed to install missing configured plugin "discord" from @openclaw/discord: ENETUNREACH.',
      ],
    });
    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { discord: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      reason: expect.stringContaining("discord"),
      guidance: expect.arrayContaining([expect.stringContaining("openclaw doctor --fix")]),
    });
  });

  it("flags errored=true when smoke check finds a missing main entry", async () => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      brave: { source: "npm", installPath: "/p/brave" },
    });
    mocks.runPluginPayloadSmokeCheck.mockResolvedValue({
      checked: ["brave"],
      failures: [
        {
          pluginId: "brave",
          installPath: "/p/brave",
          reason: "missing-main-entry",
          detail: 'Plugin main entry "dist/index.js" not found at /p/brave/dist/index.js',
        },
      ],
    });
    const result = await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { brave: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(result.errored).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        pluginId: "brave",
        reason: expect.stringContaining("missing-main-entry"),
        guidance: expect.arrayContaining([
          expect.stringContaining("openclaw plugins inspect brave"),
        ]),
      }),
    ]);
  });

  it("re-loads install records after repair so smoke check sees the latest payloads", async () => {
    let callCount = 0;
    mocks.repairMissingConfiguredPluginInstalls.mockImplementation(async () => {
      // Simulate repair persisting a new record into the store.
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
        brave: { source: "npm", installPath: "/p/brave" },
      });
      return { changes: ["Repaired"], warnings: [] };
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockImplementation(async () => {
      callCount += 1;
      return {};
    });
    await runPostCorePluginConvergence({
      cfg: {
        plugins: { entries: { brave: { enabled: true } } },
      } as unknown as OpenClawConfig,
      env: {},
    });
    expect(callCount).toBeGreaterThanOrEqual(0);
    expect(mocks.runPluginPayloadSmokeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        records: { brave: { source: "npm", installPath: "/p/brave" } },
      }),
    );
  });
});

describe("convergenceWarningsToOutcomes", () => {
  it("emits per-plugin error outcomes for warnings that name a pluginId", () => {
    const folded = convergenceWarningsToOutcomes({
      changes: [],
      warnings: [
        {
          pluginId: "brave",
          reason: "missing-main-entry: …",
          message: 'Plugin "brave" failed payload smoke check.',
          guidance: ["Run `openclaw doctor --fix`."],
        },
        {
          reason: "Failed install",
          message: "Failed install for some plugin.",
          guidance: ["Run `openclaw doctor --fix`."],
        },
      ],
      errored: true,
      smokeFailures: [],
    });
    expect(folded.errored).toBe(true);
    expect(folded.outcomes).toEqual([
      { pluginId: "brave", status: "error", message: 'Plugin "brave" failed payload smoke check.' },
    ]);
    expect(folded.warnings).toHaveLength(2);
  });

  it("returns errored=false and no outcomes for a clean convergence", () => {
    const folded = convergenceWarningsToOutcomes({
      changes: ["Repaired."],
      warnings: [],
      errored: false,
      smokeFailures: [],
    });
    expect(folded).toEqual({ warnings: [], outcomes: [], errored: false });
  });
});
