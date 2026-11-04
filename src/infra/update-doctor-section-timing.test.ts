import { describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
import { createUpdateDoctorSectionTiming } from "./update-doctor-section-timing.js";

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
      trace,
    ].join("");
    const stdout = Buffer.from("Doctor: state schema\n");
    const run = timing.wrap(async (_argv: string[], options: CommandOptions) => {
      options.onOutputChunk?.(stdout, "stdout");
      const bytes = Buffer.from(stderr);
      for (let offset = 0; offset < bytes.length; offset += size) {
        options.onOutputChunk?.(bytes.subarray(offset, offset + size), "stderr");
      }
      expect(display.mock.calls.flat()).toEqual([
        "Doctor: state schema",
        "Doctor: database migrations (10s elapsed)",
        "Doctor: maintenance release",
      ]);
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
      diagnostics: ["Doctor sections: state-schema 2.5 s"],
    });
  });

  it("does not publish an incomplete phase at terminal annotation", async () => {
    const display = vi.fn();
    const timing = createUpdateDoctorSectionTiming({}, display);
    const stderr = "Doctor: state schema";
    await timing.wrap(async (_argv: string[], options: CommandOptions) => {
      options.onOutputChunk?.(Buffer.from(stderr), "stderr");
      return { stderr };
    })([], {});
    timing.annotate({ diagnostics: [] });
    expect(display).not.toHaveBeenCalled();
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
