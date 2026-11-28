import { describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
import { createUpdateDoctorSectionTiming } from "./update-doctor-section-timing.js";
import { UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";

const traceLine = (name: string, milliseconds: number, detail = "") =>
  `[gateway] startup trace: doctor.${name} ${milliseconds.toFixed(1)}ms total=1.0ms${detail}`;

async function replayDoctorStderr(stderr: string, parentEnv: NodeJS.ProcessEnv = {}) {
  const timing = createUpdateDoctorSectionTiming(parentEnv);
  const run = timing.wrap(async (_argv: string[], options: CommandOptions) => {
    options.onOutputChunk?.(Buffer.from(stderr), "stderr");
    return { stderr };
  });
  const result = await run([], {});
  return {
    stderr: result.stderr,
    diagnostics: timing.annotate({ diagnostics: [] as string[] }).diagnostics,
  };
}

describe("Doctor sections diagnostic", () => {
  // Order and names follow a captured `doctor --fix` trace: every step is preceded by its
  // `doctor.pending.<step>` decision, so decisions outnumber timed sections.
  const sections = [
    ["retained-runtimes", 200],
    ["maintenance.begin", 400],
    ["database-migrations", 20_700],
    ["state-schema", 200],
    ["config-flow", 2700],
  ] as const;
  const contributions = Array.from({ length: 40 }, (_, index) => `doctor:check-${index + 10}`);
  const lateSections = [
    ["contributions", 5500],
    ["external-config", 0],
    ["maintenance-ready", 500],
    ["sqlite-reclamation", 200],
    ["maintenance.release", 0],
  ] as const;
  const pending = (step: string) => traceLine(`pending.${step}`, 0, " pending=work check=default");
  const stderr = [
    "[gateway] startup trace: doctor.still-running starting total=0.1ms",
    traceLine("startup", 0),
    ...sections.flatMap(([name, ms]) => [pending(name), traceLine(name, ms)]),
    ...contributions.flatMap((id, index) => [
      pending(`contribution.${id}`),
      traceLine(`contribution.${id}`, (index + 1) * 100),
    ]),
    ...lateSections.flatMap(([name, ms]) => [pending(name), traceLine(name, ms)]),
    "",
  ].join("\n");

  it("reports timed sections without the pending decisions that precede them", async () => {
    const result = await replayDoctorStderr(stderr);
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([
      "Doctor sections: startup 0.0 s, retained-runtimes 0.2 s, maintenance.begin 0.4 s, " +
        "database-migrations 20.7 s, state-schema 0.2 s, config-flow 2.7 s, contributions 5.5 s, " +
        "external-config 0.0 s, maintenance-ready 0.5 s, sqlite-reclamation 0.2 s, " +
        "maintenance.release 0.0 s; slowest contributions: check-49 4.0 s, check-48 3.9 s, " +
        "check-47 3.8 s, check-46 3.7 s, check-45 3.6 s",
    ]);
  });

  it("leaves every pending decision in an operator-enabled trace", async () => {
    const result = await replayDoctorStderr(stderr, { OPENCLAW_GATEWAY_STARTUP_TRACE: "1" });
    expect(result.stderr).toBe(stderr);
    expect(result.stderr.match(/startup trace: doctor\.pending\./gu)).toHaveLength(
      sections.length + contributions.length + lateSections.length,
    );
  });

  it("still bounds a genuinely long list of timed sections", async () => {
    const names = Array.from({ length: 80 }, (_, index) => `maintenance.section-${index}`);
    const { diagnostics } = await replayDoctorStderr(
      `${names.map((name) => traceLine(name, 1500)).join("\n")}\n`,
    );
    const [line] = diagnostics;
    expect(line).toHaveLength(UPDATE_RUN_TEXT_LIMIT);
    expect(line).toMatch(/^Doctor sections: maintenance\.section-0 1\.5 s, .*…$/u);
  });
});

describe("delegated Doctor phase output", () => {
  it.each([1, 7, 65_536])("bounds and decodes stderr with %i-byte chunks", async (size) => {
    const display = vi.fn();
    const observer = vi.fn();
    const timing = createUpdateDoctorSectionTiming({}, display);
    const trace = "[gateway] startup trace: doctor.state-schema 2500.0ms total=2500.0ms\n";
    const stderr = [
      "private diagnostic 🦊 /private/fixture-secret\n",
      "Doctor: state schema\n",
      "Doctor: database migrations (10s elapsed)\n",
      "Doctor: private plugin label\n",
      "Doctor: state schema /private/fixture-secret\n",
      "Doctor: state schema\rprivate\n",
      "Doctor: state schema\x1b[2J\n",
      "Doctor: state schema (12345678901s elapsed)\n",
      `${"x".repeat(32_768)}Doctor: state schema\n`,
      "Doctor: maintenance release\n",
      "Retirement-only Doctor widened: config.preflight-config-changed\n".repeat(2),
      "Retirement-only Doctor widened: config.model-retirement.warning-notes.codex-routes\n",
      "Retirement-only Doctor widened: private/plugin-label\n",
      trace,
      "Doctor: state schema",
    ].join("");
    const stdout = Buffer.from("Doctor: state schema\n");
    const run = timing.wrap(async (_argv: string[], options: CommandOptions) => {
      options.onOutputChunk?.(stdout, "stdout");
      const bytes = Buffer.from(stderr);
      for (let offset = 0; offset < bytes.length; offset += size) {
        options.onOutputChunk?.(bytes.subarray(offset, offset + size), "stderr");
      }
      return { stderr, stdout: stdout.toString() };
    });
    const result = await run([], { onOutputChunk: observer });
    expect(result).toEqual({ stderr: stderr.replace(trace, ""), stdout: stdout.toString() });
    expect(observer).toHaveBeenCalledWith(stdout, "stdout");
    expect(
      Buffer.concat(
        observer.mock.calls.filter(([, stream]) => stream === "stderr").map(([chunk]) => chunk),
      ).toString(),
    ).toBe(stderr);
    expect(timing.annotate({ diagnostics: [] })).toEqual({
      diagnostics: [
        "Doctor sections: state-schema 2.5 s",
        "Retirement-only Doctor widened: config.preflight-config-changed",
        "Retirement-only Doctor widened: config.model-retirement.warning-notes.codex-routes",
      ],
    });
    expect(display.mock.calls.flat()).toEqual([
      "Doctor: state schema",
      "Doctor: database migrations (10s elapsed)",
      "Doctor: maintenance release",
    ]);
  });

  it.each(["stop", "throw"] as const)(
    "preserves the original observer's %s after a synchronous display failure",
    async (behavior) => {
      const error = new Error("original observer failure");
      const display = vi.fn(() => {
        throw new Error("advisory display failure");
      });
      const observer = vi.fn(() => {
        if (behavior === "throw") {
          throw error;
        }
        return false;
      });
      const timing = createUpdateDoctorSectionTiming({}, display);
      const run = timing.wrap(async (_argv: string[], options: CommandOptions) => {
        expect(options.onOutputChunk?.(Buffer.from("Doctor: state schema\n"), "stderr")).toBe(
          false,
        );
        return { stderr: "captured diagnostic" };
      });
      const result = run([], { onOutputChunk: observer });
      if (behavior === "throw") {
        await expect(result).rejects.toBe(error);
      } else {
        await expect(result).resolves.toEqual({ stderr: "captured diagnostic" });
      }
      expect(display).toHaveBeenCalledOnce();
      expect(observer).toHaveBeenCalledOnce();
    },
  );
});
