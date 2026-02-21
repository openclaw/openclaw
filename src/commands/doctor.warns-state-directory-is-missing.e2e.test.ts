import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDoctorRuntime, mockDoctorConfigSnapshot, note } from "./doctor.e2e-harness.js";

describe("doctor command", () => {
  it("warns when the state directory is missing", async () => {
    mockDoctorConfigSnapshot();

    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-missing-state-"));
    fs.rmSync(missingDir, { recursive: true, force: true });
    process.env.OPENCLAW_STATE_DIR = missingDir;
    note.mockClear();

    const { doctorCommand } = await import("./doctor.js");
    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const stateNote = note.mock.calls.find((call) => call[1] === "State integrity");
    expect(stateNote).toBeTruthy();
    expect(String(stateNote?.[0])).toContain("CRITICAL");
  }, 30_000);

  it("warns about opencode provider overrides", async () => {
    mockDoctorConfigSnapshot({
      config: {
        models: {
          providers: {
            opencode: {
              api: "openai-completions",
              baseUrl: "https://opencode.ai/zen/v1",
            },
          },
        },
      },
    });

    const { doctorCommand } = await import("./doctor.js");
    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const warned = note.mock.calls.some(
      ([message, title]) =>
        title === "OpenCode Zen" && String(message).includes("models.providers.opencode"),
    );
    expect(warned).toBe(true);
  });

  it("skips gateway auth warning when OPENCLAW_GATEWAY_TOKEN is set", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: { mode: "local" },
      },
    });

    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-1234567890";
    note.mockClear();

    try {
      const { doctorCommand } = await import("./doctor.js");
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    }

    const warned = note.mock.calls.some(([message]) =>
      String(message).includes("Gateway auth is off or missing a token"),
    );
    expect(warned).toBe(false);
  });
});
