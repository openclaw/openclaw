import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorRuntime, mockDoctorConfigSnapshot } from "./doctor.e2e-harness.js";
import { loadDoctorCommandForTest, terminalNoteMock } from "./doctor.note-test-helpers.js";
import "./doctor.fast-path-mocks.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor command --json", () => {
  beforeEach(async () => {
    mockDoctorConfigSnapshot({
      config: {
        channels: {
          telegram: { enabled: true },
          whatsapp: { enabled: true },
        },
      },
    });

    doctorCommand = await loadDoctorCommandForTest({
      unmockModules: ["../flows/doctor-health-contributions.js", "./doctor-state-integrity.js"],
    });
  });

  it("writes a single JSON payload and suppresses notes/fix hints", async () => {
    const runtime = createDoctorRuntime();
    const originalWrite = process.stdout.write.bind(process.stdout);
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await doctorCommand(runtime, {
        json: true,
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(terminalNoteMock).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Run "openclaw doctor --fix" to apply changes.'),
    );

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      ok: true,
      command: "doctor",
      channels: expect.any(Array),
    });
  });
});
