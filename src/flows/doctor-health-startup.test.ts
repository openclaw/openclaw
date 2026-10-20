import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNonExitingRuntime } from "../runtime.js";
import { prepareDoctorHealthFlow, prepareDoctorStateSchema } from "./doctor-health-startup.js";

const mocks = vi.hoisted(() => ({
  config: vi.fn<() => Promise<OpenClawConfig>>(),
  command: vi.fn(),
  note: vi.fn(),
  migrateState: vi.fn(),
}));
// mock-isolation: isolate startup from operator paths, config, tools, terminal and databases.
vi.mock("../config/paths.js", () => ({
  resolveIsNixMode: () => false,
  resolveStateDir: () => "/synthetic/openclaw-state",
}));
vi.mock("../config/io.runtime.js", () => ({ readSourceConfigBestEffort: mocks.config }));
vi.mock("../process/exec.js", () => ({ runUtf8CommandWithTimeout: mocks.command }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => "/synthetic/openclaw"),
}));
vi.mock("../infra/state-migrations.doctor.js", () => ({
  prepareLegacyStateDatabaseSchema: mocks.migrateState,
}));

beforeEach(() => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "");
  mocks.config.mockReset().mockResolvedValue({ gateway: { tailscale: { mode: "serve" } } });
  mocks.command.mockReset();
  mocks.note.mockReset();
  mocks.migrateState.mockReset().mockResolvedValue({
    id: "state-schema",
    phase: "shared",
    source: [],
    target: [],
    requiredness: "conditional",
    reversibility: "checkpoint-required",
    outcome: "completed",
    changes: [],
    warnings: [],
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("Doctor startup dependencies", () => {
  it.each(["quick", "full"] as const)(
    "preserves %s integrity selection for early shared-state migration",
    async (check) => {
      await prepareDoctorStateSchema(
        {
          incompatible: [],
          indeterminate: [],
          pendingMigrations: [
            {
              kind: "state",
              path: "/synthetic/openclaw.sqlite",
              foundVersion: 1,
              supportedVersion: 2,
            },
          ],
        },
        true,
        check,
      );
      expect(mocks.migrateState).toHaveBeenCalledExactlyOnceWith(process.env, check);
    },
  );

  it("continues published-updater Doctor without invoking unsupported config reads", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    mocks.config.mockRejectedValue(
      new Error(
        "Run config operation readSourceConfigBestEffort in the updated CLI after this update finishes.",
      ),
    );
    await expect(
      prepareDoctorHealthFlow(
        createNonExitingRuntime(),
        { repair: true, nonInteractive: true },
        vi.fn(),
      ),
    ).resolves.toMatchObject({ root: "/synthetic/openclaw" });
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("reports a non-running backend before admitting Doctor maintenance", async () => {
    mocks.command.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ BackendState: "UnknownFutureState" }),
    });
    await prepareDoctorHealthFlow(createNonExitingRuntime(), {}, vi.fn());
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("did not report a running backend"),
      "Gateway startup prerequisite",
    );
    expect(mocks.note.mock.calls[0]?.[0]).toContain("Inspect");
    // Prerequisite inspection cannot enable connectivity or alter routes.
    expect(mocks.command.mock.calls.map(([argv]) => argv)).toEqual([
      ["tailscale", "status", "--json"],
    ]);
  });
});
