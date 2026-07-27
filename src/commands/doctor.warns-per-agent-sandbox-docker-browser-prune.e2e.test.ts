// Doctor sandbox browser prune e2e tests cover per-agent stale browser artifacts and warning output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorRuntime, mockDoctorConfigSnapshot } from "./doctor.e2e-harness.js";
import { loadDoctorCommandForTest, terminalNoteMock } from "./doctor.note-test-helpers.js";
import "./doctor.fast-path-mocks.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor command", () => {
  beforeAll(async () => {
    doctorCommand = await loadDoctorCommandForTest({
      unmockModules: ["./doctor-sandbox.js", "../flows/doctor-health-contributions.js"],
    });
    await import("../flows/doctor-health-contributions.js");
    // Warm every real doctor contribution outside the per-case timeout.
    mockDoctorConfigSnapshot({
      config: { agents: { entries: { main: { default: true } } } },
    });
    await doctorCommand(createDoctorRuntime(), { nonInteractive: true });
  });

  beforeEach(() => {
    terminalNoteMock.mockClear();
  });

  it("warns when per-agent sandbox docker/browser/prune overrides are ignored under shared scope", async () => {
    mockDoctorConfigSnapshot({
      config: {
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
              scope: "shared",
            },
          },
          entries: {
            main: { default: true },
            work: {
              sandbox: {
                mode: "all",
                scope: "shared",
                docker: {
                  setupCommand: "echo work",
                },
                browser: { enabled: true },
                prune: { idleHours: 24 },
              },
            },
          },
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), { nonInteractive: true });

    const matchingSandboxNotes = terminalNoteMock.mock.calls.filter(([message, title]) => {
      if (title !== "Sandbox" || typeof message !== "string") {
        return false;
      }
      const normalized = message.replace(/\s+/g, " ").trim();
      return (
        normalized.includes('agents.entries.work (id "work") sandbox docker/browser/prune') &&
        normalized.includes('scope resolves to "shared"')
      );
    });
    expect(matchingSandboxNotes.length).toBeGreaterThan(0);
  }, 30_000);

  it("does not warn when a keyed agent owns its sandbox overrides", async () => {
    mockDoctorConfigSnapshot({
      config: {
        agents: {
          defaults: { sandbox: { mode: "off", scope: "shared" } },
          entries: {
            main: { default: true },
            work: {
              sandbox: {
                mode: "all",
                scope: "agent",
                docker: { setupCommand: "echo work" },
                browser: { enabled: true },
                prune: { idleHours: 24 },
              },
            },
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
          message.includes("agents.entries.work"),
      ),
    ).toBe(false);
  }, 30_000);

  it("does not warn when only the active workspace is present", async () => {
    mockDoctorConfigSnapshot({
      config: {
        agents: { defaults: { workspace: "/Users/steipete/openclaw" } },
      },
    });

    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/Users/steipete");
    const realExists = fs.existsSync;
    const legacyPath = path.join("/Users/steipete", "openclaw");
    const legacyAgentsPath = path.join(legacyPath, "AGENTS.md");
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((value) => {
      if (
        value === "/Users/steipete/openclaw" ||
        value === legacyPath ||
        value === legacyAgentsPath
      ) {
        return true;
      }
      return realExists(value as never);
    });

    await doctorCommand(createDoctorRuntime(), { nonInteractive: true });

    const noteTitles = terminalNoteMock.mock.calls.map(([_, title]) => title);
    expect(noteTitles).not.toContain("Extra workspace");

    homedirSpy.mockRestore();
    existsSpy.mockRestore();
  });
});
