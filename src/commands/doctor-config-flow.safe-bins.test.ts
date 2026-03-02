import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigWithInput } from "./doctor-config-flow.test-utils.js";

const { noteSpy } = vi.hoisted(() => ({
  noteSpy: vi.fn(),
}));

vi.mock("../terminal/note.js", () => ({
  note: noteSpy,
}));

import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";

describe("doctor config flow safe bins", () => {
  beforeEach(() => {
    noteSpy.mockClear();
  });

  it("scaffolds missing custom safe-bin profiles on repair but skips interpreter bins", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        tools: {
          exec: {
            safeBins: ["myfilter", "python3"],
          },
        },
        agents: {
          list: [
            {
              id: "ops",
              tools: {
                exec: {
                  safeBins: ["mytool", "node"],
                },
              },
            },
          ],
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      tools?: {
        exec?: {
          safeBinProfiles?: Record<string, object>;
        };
      };
      agents?: {
        list?: Array<{
          id: string;
          tools?: {
            exec?: {
              safeBinProfiles?: Record<string, object>;
            };
          };
        }>;
      };
    };
    expect(cfg.tools?.exec?.safeBinProfiles?.myfilter).toEqual({});
    expect(cfg.tools?.exec?.safeBinProfiles?.python3).toBeUndefined();
    const ops = cfg.agents?.list?.find((entry) => entry.id === "ops");
    expect(ops?.tools?.exec?.safeBinProfiles?.mytool).toEqual({});
    expect(ops?.tools?.exec?.safeBinProfiles?.node).toBeUndefined();
  });

  it("warns when interpreter/custom safeBins entries are missing profiles in non-repair mode", async () => {
    await runDoctorConfigWithInput({
      config: {
        tools: {
          exec: {
            safeBins: ["python3", "myfilter"],
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("tools.exec.safeBins includes interpreter/runtime 'python3'"),
      "Doctor warnings",
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("openclaw doctor --fix"),
      "Doctor warnings",
    );
  });

  it("hints safeBinTrustedDirs when safeBins resolve outside default trusted dirs", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-safe-bins-"));
    const binPath = path.join(dir, "mydoctorbin");
    try {
      await fs.writeFile(binPath, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(binPath, 0o755);
      await withEnvAsync(
        {
          PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        async () => {
          await runDoctorConfigWithInput({
            config: {
              tools: {
                exec: {
                  safeBins: ["mydoctorbin"],
                  safeBinProfiles: {
                    mydoctorbin: {},
                  },
                },
              },
            },
            run: loadAndMaybeMigrateDoctorConfig,
          });
        },
      );
      expect(noteSpy).toHaveBeenCalledWith(
        expect.stringContaining("outside trusted safe-bin dirs"),
        "Doctor warnings",
      );
      expect(noteSpy).toHaveBeenCalledWith(
        expect.stringContaining("tools.exec.safeBinTrustedDirs"),
        "Doctor warnings",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
