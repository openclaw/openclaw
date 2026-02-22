import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";

const { noteSpy } = vi.hoisted(() => ({
  noteSpy: vi.fn(),
}));

vi.mock("../terminal/note.js", () => ({
  note: noteSpy,
}));

import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";

async function runDoctorConfigWithInput(params: {
  config: Record<string, unknown>;
  repair?: boolean;
}) {
  return withTempHome(async (home) => {
    const configDir = path.join(home, ".openclaw");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "openclaw.json"),
      JSON.stringify(params.config, null, 2),
      "utf-8",
    );
    return loadAndMaybeMigrateDoctorConfig({
      options: { nonInteractive: true, repair: params.repair },
      confirm: async () => false,
    });
  });
}

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
});
