// probe: run this e2e on unmodified main (throwaway PR, do not merge)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorRuntime, mockDoctorConfigSnapshot } from "./doctor.e2e-harness.js";
import { loadDoctorCommandForTest, terminalNoteMock } from "./doctor.note-test-helpers.js";
import "./doctor.fast-path-mocks.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor command", () => {
  beforeEach(async () => {
    vi.doMock("./doctor-sandbox.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./doctor-sandbox.js")>();
      return {
        ...actual,
        maybeRepairSandboxImages: async (
          cfg: Parameters<typeof actual.maybeRepairSandboxImages>[0],
        ) => cfg,
        maybeRepairSandboxRegistryFiles: async () => {},
      };
    });
    doctorCommand = await loadDoctorCommandForTest({
      unmockModules: ["../flows/doctor-health-contributions.js"],
    });
  });

  it("warns when per-agent sandbox docker/browser/prune overrides are ignored under shared scope", async () => {
    const sandbox = { mode: "all", scope: "shared" };
    mockDoctorConfigSnapshot({
      config: {
        agents: {
          defaults: { sandbox },
          entries: {
            work: { sandbox: { docker: { setupCommand: "echo work" } } },
          },
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), { nonInteractive: true });

    expect(
      terminalNoteMock.mock.calls.some(
        ([message, title]) =>
          title === "Sandbox" &&
          typeof message === "string" &&
          /(?=[\s\S]*agents\.entries\.work\s+sandbox\s+docker)(?=[\s\S]*scope\s+resolves\s+to\s+"shared")/.test(
            message,
          ),
      ),
    ).toBe(true);
  }, 30_000);

  it("does not warn when only the active workspace is present", async () => {
    const workspace = "/Users/steipete/openclaw";
    mockDoctorConfigSnapshot({ config: { agents: { defaults: { workspace } } } });
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/Users/steipete");
    const realExists = fs.existsSync;
    const existsSpy = vi
      .spyOn(fs, "existsSync")
      .mockImplementation(
        (value) =>
          value === workspace || value === path.join(workspace, "AGENTS.md") || realExists(value),
      );

    await doctorCommand(createDoctorRuntime(), { nonInteractive: true });

    expect(terminalNoteMock.mock.calls.map(([, title]) => title)).not.toContain("Extra workspace");

    homedirSpy.mockRestore();
    existsSpy.mockRestore();
  });
});
