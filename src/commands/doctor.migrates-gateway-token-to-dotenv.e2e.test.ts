import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDoctorRuntime,
  mockDoctorConfigSnapshot,
  writeConfigFile,
} from "./doctor.e2e-harness.js";

describe("doctor command", () => {
  it("migrates literal gateway token into state dotenv and keeps env ref in config", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          auth: {
            mode: "token",
            token: "doctor-token-1234567890",
          },
        },
      },
    });

    const { doctorCommand } = await import("./doctor.js");
    const runtime = createDoctorRuntime();

    await doctorCommand(runtime, { repair: true });

    expect(writeConfigFile).toHaveBeenCalled();
    const persisted = writeConfigFile.mock.calls.at(-1)?.[0] as {
      gateway?: { auth?: { token?: string } };
    };
    expect(persisted.gateway?.auth?.token).toBe("${OPENCLAW_GATEWAY_TOKEN}");

    const stateDir = process.env.OPENCLAW_STATE_DIR as string;
    const dotenvRaw = await fs.readFile(path.join(stateDir, ".env"), "utf8");
    expect(dotenvRaw).toContain("OPENCLAW_GATEWAY_TOKEN=doctor-token-1234567890");
  });
});
