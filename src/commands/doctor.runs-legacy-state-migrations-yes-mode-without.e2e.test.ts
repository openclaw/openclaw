import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  arrangeLegacyStateMigrationTest,
  confirm,
  createDoctorRuntime,
  ensureAuthProfileStore,
  mockDoctorConfigSnapshot,
  serviceIsLoaded,
  serviceRestart,
  writeConfigFile,
} from "./doctor.e2e-harness.js";
import "./doctor.fast-path-mocks.js";

vi.mock("./doctor-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-auth.js")>();
  return {
    ...actual,
    maybeRemoveDeprecatedCliAuthProfiles: vi.fn(async (cfg: unknown) => cfg),
    noteAuthProfileHealth: vi.fn().mockResolvedValue(undefined),
  };
});

let doctorCommand: typeof import("./doctor.js").doctorCommand;
let healthCommand: typeof import("./health.js").healthCommand;

describe("doctor command", () => {
  beforeAll(async () => {
    ({ doctorCommand } = await import("./doctor.js"));
    ({ healthCommand } = await import("./health.js"));
  });

  it("runs legacy state migrations in yes mode without prompting", async () => {
    const { doctorCommand, runtime, runLegacyStateMigrations } =
      await arrangeLegacyStateMigrationTest();

    await (doctorCommand as (runtime: unknown, opts: Record<string, unknown>) => Promise<void>)(
      runtime,
      { yes: true },
    );

    expect(runLegacyStateMigrations).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  }, 30_000);

  it("skips legacy state migrations in non-interactive fast path", async () => {
    const { doctorCommand, runtime, runLegacyStateMigrations } =
      await arrangeLegacyStateMigrationTest();

    await (doctorCommand as (runtime: unknown, opts: Record<string, unknown>) => Promise<void>)(
      runtime,
      { nonInteractive: true },
    );

    expect(runLegacyStateMigrations).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  }, 30_000);

  it("skips gateway restarts in non-interactive mode", async () => {
    mockDoctorConfigSnapshot();

    vi.mocked(healthCommand).mockRejectedValueOnce(new Error("gateway closed"));

    serviceIsLoaded.mockResolvedValueOnce(true);
    serviceRestart.mockClear();
    confirm.mockClear();

    await doctorCommand(createDoctorRuntime(), { nonInteractive: true });

    expect(serviceRestart).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("migrates anthropic oauth config profile id when only email profile exists", async () => {
    mockDoctorConfigSnapshot({
      config: {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "oauth" },
          },
        },
      },
    });

    ensureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "anthropic:me@example.com": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          email: "me@example.com",
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), { yes: true });

    const written = writeConfigFile.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const profiles = (written.auth as { profiles: Record<string, unknown> }).profiles;
    expect(profiles["anthropic:me@example.com"]).toBeTruthy();
    expect(profiles["anthropic:default"]).toBeUndefined();
  }, 30_000);
});
