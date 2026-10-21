import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
// mock-isolation: startup admission uses synthetic config, not operator files.
vi.mock("../config/io.runtime.js", () => ({ readSourceConfigBestEffort: mocks.config }));
// mock-isolation: startup health checks must not execute real host commands.
vi.mock("../process/exec.js", () => ({ runUtf8CommandWithTimeout: mocks.command }));
// mock-isolation: capture startup warnings without terminal side effects.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
// mock-isolation: startup resolves a synthetic installation root, not the live checkout.
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => "/synthetic/openclaw"),
}));
// mock-isolation: startup selection must not migrate real operator databases.
vi.mock("../infra/state-migrations.doctor.js", () => ({
  prepareLegacyStateDatabaseSchema: mocks.migrateState,
}));

beforeEach(() => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "");
  mocks.config.mockReset().mockResolvedValue({ gateway: { tailscale: { mode: "serve" } } });
  mocks.command.mockReset();
  mocks.note.mockReset();
  mocks.migrateState.mockReset().mockResolvedValue({ outcome: "completed" });
});

afterEach(() => vi.unstubAllEnvs());

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
            path: "/state.sqlite",
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
  const startup = prepareDoctorHealthFlow(
    createNonExitingRuntime(),
    { repair: true, nonInteractive: true },
    vi.fn(),
  );
  await expect(startup).resolves.toMatchObject({ root: "/synthetic/openclaw" });
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
  expect(mocks.note).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("did not report a running backend. Inspect"),
    "Gateway startup prerequisite",
  );
  expect(mocks.command.mock.calls.map(([argv]) => argv)).toEqual([
    ["tailscale", "status", "--json"],
  ]);
});
