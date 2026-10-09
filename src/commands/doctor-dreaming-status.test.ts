import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatDoctorDreamingSummary } from "../memory-host-sdk/dreaming-doctor-summary.js";

const note = vi.hoisted(() => vi.fn());

// mock-isolation: capture Doctor note text without rendering a terminal prompt
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

import { noteDreamingHealth } from "./doctor-memory-recall.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const enabledCfg = {
  memory: { search: { enabled: false } },
  plugins: {
    entries: {
      "memory-core": {
        config: { dreaming: { enabled: true, frequency: "15 4 * * *" } },
      },
    },
  },
} satisfies OpenClawConfig;

describe("doctor dreaming status", () => {
  it("reports the managed cron run without calling it a promotion", () => {
    const summary = formatDoctorDreamingSummary({
      cfg: enabledCfg,
      cron: {
        available: true,
        jobs: [
          {
            name: "Memory Dreaming Promotion",
            description: "[managed-by=memory-core.short-term-promotion]",
            enabled: true,
            payload: {
              kind: "systemEvent",
              text: "__openclaw_memory_core_short_term_promotion_dream__",
            },
            state: {
              lastRunAtMs: Date.parse("2026-10-07T04:15:00.000Z"),
              nextRunAtMs: Date.parse("2026-10-08T04:15:00.000Z"),
            },
          },
          {
            name: "operator reminder",
            enabled: true,
            state: {
              lastRunAtMs: Date.parse("2026-10-08T00:00:00.000Z"),
              nextRunAtMs: Date.parse("2026-10-08T01:00:00.000Z"),
            },
          },
        ],
      },
    });

    expect(summary).toBe(
      [
        "Dreaming: enabled (cadence 15 4 * * *).",
        "Last dreaming run: 2026-10-07T04:15:00.000Z.",
        "Next scheduled run: 2026-10-08T04:15:00.000Z.",
      ].join("\n"),
    );
    expect(summary).not.toContain("promotion");
    expect(summary).not.toContain("2026-10-08T00:00:00.000Z");
  });

  it("still names dreaming when it is disabled and the schedule is unknown", () => {
    const summary = formatDoctorDreamingSummary({
      cfg: {
        plugins: {
          entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
        },
      },
      cron: { available: false },
    });

    expect(summary).toBe(
      ["Dreaming: disabled.", "Last dreaming run: unknown.", "Next scheduled run: unknown."].join(
        "\n",
      ),
    );
  });

  it("notes dreaming from an empty state store while memory search is disabled", async () => {
    note.mockClear();
    const stateDir = tempDirs.make("doctor-dreaming-status-");
    await noteDreamingHealth(enabledCfg, {
      OPENCLAW_STATE_DIR: stateDir,
      HOME: stateDir,
    });

    expect(note).toHaveBeenCalledWith(
      [
        "Dreaming: enabled (cadence 15 4 * * *).",
        "Last dreaming run: none.",
        "Next scheduled run: none.",
      ].join("\n"),
      "Dreaming",
    );
  });
});
