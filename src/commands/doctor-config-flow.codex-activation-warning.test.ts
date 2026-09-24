import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const note = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

type ActivationCase = {
  name: string;
  entry: PluginEntryConfig;
  allow?: string[];
  persistedAllow?: string[];
  warning: boolean;
};

const optOut = { sessionCatalog: { enabled: false } };

describe("Doctor Codex activation advisory", () => {
  afterEach(() => {
    note.mockClear();
    closeOpenClawStateDatabaseForTest();
  });

  it.each<ActivationCase>([
    {
      name: "a first-write opt-out with a non-Codex model",
      entry: { config: optOut },
      allow: ["anthropic"],
      warning: false,
    },
    {
      name: "historical enablement without an allowlist",
      entry: { enabled: true, config: optOut },
      warning: true,
    },
    {
      name: "historical enablement with an empty allowlist",
      entry: { enabled: true, config: optOut },
      allow: [],
      warning: true,
    },
    {
      name: "historical enablement with an expanded allowlist",
      entry: { enabled: true, config: optOut },
      allow: ["anthropic", "codex"],
      warning: true,
    },
    {
      name: "authored catalog settings",
      entry: { enabled: true, config: { sessionCatalog: { enabled: false, homes: [] } } },
      allow: ["anthropic", "codex"],
      warning: false,
    },
    {
      name: "authored entry settings",
      entry: { enabled: true, config: optOut, hooks: { allowPromptInjection: false } },
      allow: ["anthropic", "codex"],
      warning: false,
    },
    {
      name: "explicit disablement",
      entry: { enabled: false, config: optOut },
      allow: ["anthropic"],
      warning: false,
    },
    {
      name: "a restrictive allowlist without Codex",
      entry: { enabled: true, config: optOut },
      allow: ["anthropic"],
      persistedAllow: ["anthropic", "codex"],
      warning: false,
    },
  ])(
    "preserves plugin choices and reports $name",
    async ({ entry, allow, persistedAllow, warning }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          // Isolate the privacy seed from Doctor's separate implicit-default route repair.
          agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } },
          plugins: { ...(allow === undefined ? {} : { allow }), entries: { codex: entry } },
        });
        const before = await fs.readFile(configPath, "utf8");
        const ctx = await prepareDoctorContext(configPath);
        expect(await fs.readFile(configPath, "utf8")).toBe(before);
        const advisory = note.mock.calls
          .filter(
            ([message, title]) =>
              title === "Doctor warnings" && message.includes("machine auto-enablement"),
          )
          .map(([message]) => message);

        if (warning) {
          expect(advisory).toHaveLength(1);
          expect(advisory[0]).toContain("2026.9.3/2026.9.4");
          expect(advisory[0]).toContain("cannot determine");
          expect(advisory[0]).toContain("If you did not enable Codex");
          expect(advisory[0]).toContain("plugins.entries.codex.enabled=false");
          expect(advisory[0]).toContain('remove "codex" from plugins.allow');
        } else {
          expect(advisory).toEqual([]);
        }

        await runInitialConfigWriteHealth(ctx);
        const saved = await readConfigFileSnapshot();
        expect(saved.valid).toBe(true);
        expect(saved.sourceConfig.plugins?.entries?.codex).toEqual(entry);
        expect(saved.sourceConfig.plugins?.allow).toEqual(persistedAllow ?? allow);
      });
    },
  );
});
