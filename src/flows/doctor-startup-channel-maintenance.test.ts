import { beforeEach, expect, it, vi } from "vitest";
import * as startup from "../channels/plugins/lifecycle-startup.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
  decideDoctorContributionPending,
} from "./doctor-health-context.test-support.js";
import { resolveDoctorHealthContributions } from "./doctor-health-contributions.test-support.js";
import {
  collectChannelPreviewWarningHealthFindings,
  maybeRunDoctorStartupChannelMaintenance,
} from "./doctor-startup-channel-maintenance.js";

const mocks = vi.hoisted(() => ({
  resolveDoctorChannelPreviewConfig: vi.fn(async (params: { cfg: unknown }) => ({
    cfg: params.cfg,
    diagnostics: [],
  })),
  collectChannelDoctorPreviewWarnings: vi.fn(async (): Promise<string[]> => []),
}));
const cfg = { channels: { matrix: { enabled: true } } };

vi.mock("../commands/doctor/shared/preview-warnings.js", () => ({
  resolveDoctorChannelPreviewConfig: mocks.resolveDoctorChannelPreviewConfig,
}));

vi.mock("../commands/doctor/shared/channel-doctor.js", () => ({
  collectChannelDoctorPreviewWarnings: mocks.collectChannelDoctorPreviewWarnings,
}));

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.resolveDoctorChannelPreviewConfig.mockClear();
  mocks.collectChannelDoctorPreviewWarnings.mockReset().mockResolvedValue([]);
});

it("maps channel doctor preview warnings to structured findings", async () => {
  mocks.collectChannelDoctorPreviewWarnings.mockResolvedValue([
    "- channels.matrix: stale config needs startup maintenance.",
  ]);

  await expect(
    collectChannelPreviewWarningHealthFindings({ cfg, allowExec: true }),
  ).resolves.toEqual([
    expect.objectContaining({
      severity: "warning",
      message: "channels.matrix: stale config needs startup maintenance.",
      path: "channels.matrix",
      fixHint: expect.stringContaining("openclaw doctor --fix"),
    }),
  ]);
  expect(mocks.resolveDoctorChannelPreviewConfig).toHaveBeenCalledWith({
    cfg,
    env: process.env,
    allowExec: true,
  });
});

it.each([false, true])("runs Matrix startup migration only for repair=%s", async (shouldRepair) => {
  const runtime = { log: vi.fn(), error: vi.fn() };
  const run = vi.spyOn(startup, "runChannelPluginStartupMaintenance").mockResolvedValue(undefined);
  await maybeRunDoctorStartupChannelMaintenance({ cfg, runtime, shouldRepair });

  if (!shouldRepair) {
    expect(run).not.toHaveBeenCalled();
    return;
  }
  expect(run).toHaveBeenCalledOnce();
  const call = run.mock.calls[0]![0];
  expect(call.cfg).toBe(cfg);
  expect(call.env).toBe(process.env);
  expect(call.trigger).toBe("doctor-fix");
  call.log.info?.("migrated");
  call.log.warn?.("needs attention");
  expect(runtime.log).toHaveBeenCalledExactlyOnceWith("migrated");
  expect(runtime.error).toHaveBeenCalledExactlyOnceWith("needs attention");
});

it("has pending work only when a loaded channel plugin declares startup maintenance", async () => {
  const contribution = resolveDoctorHealthContributions().find(
    (entry) => entry.id === "doctor:startup-channel-maintenance",
  )!;
  const ctx = (shouldRepair: boolean) =>
    createDoctorHealthFlowContext({
      cfg,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createDoctorPrompterFixture(shouldRepair),
    });
  const previous = captureActivePluginRegistrySnapshot();
  try {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "plain", plugin: createChannelTestPluginBase({ id: "plain" }), source: "test" },
      ]),
    );
    await expect(decideDoctorContributionPending(contribution, ctx(true))).resolves.toBe("none");

    const runStartupMaintenance = vi.fn(async () => {});
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "maintained",
          plugin: {
            ...createChannelTestPluginBase({ id: "maintained" }),
            lifecycle: { runStartupMaintenance },
          },
          source: "test",
        },
      ]),
    );
    await expect(decideDoctorContributionPending(contribution, ctx(false))).resolves.toBe("none");
    const repair = ctx(true);
    await expect(decideDoctorContributionPending(contribution, repair)).resolves.toBe("work");
    expect(runStartupMaintenance).not.toHaveBeenCalled();
    await contribution.run(repair);
    expect(runStartupMaintenance).toHaveBeenCalledOnce();
  } finally {
    restoreActivePluginRegistrySnapshot(previous);
  }
});
