import { describe, expect, it, vi } from "vitest";
import { createDoctorRuntime, runChannelPluginStartupMaintenance } from "./doctor.e2e-harness.js";
import "./doctor.fast-path-mocks.js";

const loadAndMaybeMigrateDoctorConfigMock = vi.hoisted(() => vi.fn());

vi.mock("./doctor-config-flow.js", () => ({
  loadAndMaybeMigrateDoctorConfig: (...args: unknown[]) =>
    loadAndMaybeMigrateDoctorConfigMock(...args),
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: vi.fn(() => []),
}));

import { doctorCommand } from "./doctor.js";

const DOCTOR_MIGRATION_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 45_000;

describe("doctor command", () => {
  it(
    "runs Matrix startup migration during repair flows",
    { timeout: DOCTOR_MIGRATION_TIMEOUT_MS },
    async () => {
      const matrixConfig = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          },
        },
      };

      loadAndMaybeMigrateDoctorConfigMock.mockResolvedValueOnce({
        cfg: matrixConfig,
        path: "/tmp/openclaw.json",
        shouldWriteConfig: false,
        sourceConfigValid: true,
      });

      await doctorCommand(createDoctorRuntime(), { nonInteractive: true, repair: true });

      expect(runChannelPluginStartupMaintenance).toHaveBeenCalledTimes(1);
      expect(runChannelPluginStartupMaintenance).toHaveBeenCalledWith(
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
