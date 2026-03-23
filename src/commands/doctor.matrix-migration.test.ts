import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDoctorRuntime,
  mockDoctorConfigSnapshot,
  runStartupMatrixMigration,
} from "./doctor.e2e-harness.js";
import "./doctor.fast-path-mocks.js";

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: vi.fn(() => []),
}));

const DOCTOR_MIGRATION_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 45_000;
let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor command", () => {
  beforeAll(async () => {
    ({ doctorCommand } = await import("./doctor.js"));
  });

  it(
    "runs Matrix startup migration during repair flows",
    { timeout: DOCTOR_MIGRATION_TIMEOUT_MS },
    async () => {
      mockDoctorConfigSnapshot({
        config: {
          channels: {
            matrix: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "tok-123",
            },
          },
        },
        parsed: {
          channels: {
            matrix: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "tok-123",
            },
          },
        },
      });

      await doctorCommand(createDoctorRuntime(), { nonInteractive: true, repair: true });

      expect(runStartupMatrixMigration).toHaveBeenCalledTimes(1);
      expect(runStartupMatrixMigration).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: expect.objectContaining({
            channels: {
              matrix: {
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
                accessToken: "tok-123",
              },
            },
          }),
          trigger: "doctor-fix",
          logPrefix: "doctor",
          log: expect.objectContaining({
            info: expect.any(Function),
            warn: expect.any(Function),
          }),
        }),
      );
    },
  );
});
