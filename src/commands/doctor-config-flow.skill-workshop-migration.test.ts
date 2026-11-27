import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/io.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const note = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());
// mock-isolation: Doctor prints notes to the terminal; the test reads them from this mock.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
const withHome = useDoctorConfigPreflightHome();

async function repair(configPath: string) {
  await using ctx = await prepareDoctorContext(configPath);
  await runInitialConfigWriteHealth(ctx);
  return JSON.parse(await fs.readFile(configPath, "utf8"));
}

afterEach(() => note.mockClear());

it.each([
  {
    name: "current settings",
    workshop: { autonomous: { mode: "propose", channelNotices: true }, maxSkillBytes: 8000 },
    expected: { autonomous: { mode: "propose", channelNotices: true }, maxSkillBytes: 8000 },
  },
  {
    name: "the retired enabled switch",
    workshop: { autonomous: { enabled: false } },
    expected: { autonomous: { mode: "off" } },
  },
  {
    name: "retired proposal settings",
    workshop: { autonomous: { mode: "auto" }, approvalPolicy: "pending", maxPending: 3 },
    expected: { autonomous: { mode: "auto" } },
  },
  {
    // Releases from 2026.10.1 ignored this entry while Workshop was built in.
    name: "a stale plugin entry from before Workshop moved into core",
    workshop: { autonomous: { mode: "off" } },
    staleEntry: { enabled: false, config: { legacySetting: true } },
    expected: { autonomous: { mode: "off" } },
  },
])(
  "Doctor moves skills.workshop into the plugin config: $name",
  ({ workshop, staleEntry, expected }) =>
    withHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        skills: { load: { watch: false }, workshop },
        ...(staleEntry ? { plugins: { entries: { "skill-workshop": staleEntry } } } : {}),
      });

      const saved = await repair(configPath);

      expect(saved.skills).toEqual({ load: { watch: false } });
      // The plugin owns the skill_workshop tool, so Doctor's tool-config auto-enable marks it on.
      expect(saved.plugins.entries["skill-workshop"]).toEqual({ enabled: true, config: expected });
      expect(saved.meta.migrations.skillWorkshopPlugin).toBe(true);
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      // The runtime reads the moved settings from the plugin's own config path.
      expect(
        snapshot.config.plugins?.entries?.["skill-workshop"]?.config?.autonomous,
      ).toMatchObject(expected.autonomous);

      // A second Doctor run finds nothing left to move.
      const again = await repair(configPath);
      expect(again.plugins.entries["skill-workshop"]).toEqual({ enabled: true, config: expected });
      expect(again.skills).toEqual({ load: { watch: false } });
    }),
);
