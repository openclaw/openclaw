import "./doctor-health.test-support.js";
import { expect, it, vi } from "vitest";
import * as startup from "./doctor-health-startup.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { createDoctorRuntime, mocks, withDoctorState } =
  await import("./doctor-health.test-support.js");

useDoctorHealthFixture();

it.each(["startup", "checks"])(
  "reports a nested EROFS target and writable-mount remedy during %s without debug output",
  async (phase) => {
    await withDoctorState(async () => {
      vi.stubEnv("OPENCLAW_DEBUG", undefined);
      const target =
        phase === "startup"
          ? "/state/tmp/openclaw-1000/gateway.lock"
          : "/state/tmp/openclaw-1000/gateway\u009b\u202e.lock";
      const cause = Object.assign(new Error("EROFS: read-only filesystem"), {
        code: "EROFS",
        path: target,
        ...(phase === "startup" ? { syscall: "open" } : { operation: "openBeneath" }),
      });
      const failure = new Error("Cannot create file beneath root", { cause });
      const startupSpy =
        phase === "startup"
          ? vi.spyOn(startup, "prepareDoctorHealthFlow").mockRejectedValueOnce(failure)
          : undefined;
      if (phase === "checks") {
        mocks.config.mockImplementationOnce(() => {
          throw failure;
        });
      }
      const runtime = createDoctorRuntime();
      try {
        await expect(runDoctorHealthFlow(runtime, { nonInteractive: true })).rejects.toBe(failure);
        const output = runtime.error.mock.calls.flat().join("\n");
        expect(output).toContain(
          phase === "startup" ? target : "/state/tmp/openclaw-1000/gateway\\u009b\\u202e.lock",
        );
        expect(output).not.toMatch(/[\u007f-\u009f\p{Bidi_Control}]/u);
        expect(output).toContain(phase === "startup" ? '"open"' : '"openBeneath"');
        expect(output).toContain("writable");
        expect(output).toContain(
          "https://docs.openclaw.ai/install/docker#read-only-container-root",
        );
        expect(failure.cause).toBe(cause);
      } finally {
        startupSpy?.mockRestore();
      }
    });
  },
);

it("does not report a read-only mount for a permission denial", async () => {
  await withDoctorState(async () => {
    const failure = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const startupSpy = vi.spyOn(startup, "prepareDoctorHealthFlow").mockRejectedValueOnce(failure);
    const runtime = createDoctorRuntime();
    try {
      await expect(runDoctorHealthFlow(runtime, { nonInteractive: true })).rejects.toBe(failure);
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      startupSpy.mockRestore();
    }
  });
});
