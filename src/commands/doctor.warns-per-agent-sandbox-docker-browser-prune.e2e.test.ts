import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { note, readConfigFileSnapshot } from "./doctor.e2e-harness.js";

describe("doctor command", () => {
  it("warns when per-agent sandbox docker/browser/prune overrides are ignored under shared scope", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              scope: "shared",
            },
          },
          list: [
            {
              id: "work",
              workspace: "~/openclaw-work",
              sandbox: {
                mode: "all",
                scope: "shared",
                docker: {
                  setupCommand: "echo work",
                },
              },
            },
          ],
        },
      },
      issues: [],
      legacyIssues: [],
    });

    note.mockClear();

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await doctorCommand(runtime, { nonInteractive: true });

    expect(
      note.mock.calls.some(([message, title]) => {
        if (title !== "Sandbox" || typeof message !== "string") {
          return false;
        }
        const normalized = message.replace(/\s+/g, " ").trim();
        return (
          normalized.includes('agents.list (id "work") sandbox docker') &&
          normalized.includes('scope resolves to "shared"')
        );
      }),
    ).toBe(true);
  }, 30_000);

  it("does not warn when only the active workspace is present", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: {
        agents: { defaults: { workspace: "/Users/steipete/openclaw" } },
      },
      issues: [],
      legacyIssues: [],
    });

    note.mockClear();
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

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await doctorCommand(runtime, { nonInteractive: true });

    expect(note.mock.calls.some(([_, title]) => title === "Extra workspace")).toBe(false);

    homedirSpy.mockRestore();
    existsSpy.mockRestore();
  });
});
