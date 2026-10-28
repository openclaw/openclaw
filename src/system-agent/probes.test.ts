// OpenClaw probe tests cover timeout handling and probe result formatting.
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeGatewayUrl, probeLocalCommand } from "./probes.js";

describe("openclaw probes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("bounds noisy local command probe output", async () => {
    const result = await probeLocalCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(32768));"],
      { timeoutMs: 1_000 },
    );

    expect(result.found).toBe(true);
    expect(result.version).toHaveLength(16 * 1024);
  });

  it("distinguishes a missing command from an unsuccessful version probe", async () => {
    expect(await probeLocalCommand("openclaw-test-missing-command-703e8602")).toMatchObject({
      found: false,
      failure: "not-found",
    });
    expect(
      await probeLocalCommand(process.execPath, ["-e", "process.exit(7)"], { timeoutMs: 1_000 }),
    ).toMatchObject({ found: false, error: "exited 7", failure: "error" });
  });

  it.runIf(process.platform !== "win32")(
    "force-kills timed-out local command probes that ignore SIGTERM",
    async () => {
      const startedAt = Date.now();
      const result = await probeLocalCommand(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        { timeoutMs: 25 },
      );

      expect(result).toMatchObject({
        command: process.execPath,
        error: "timed out after 25ms",
        failure: "error",
        found: true,
        timedOut: true,
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    },
  );

  it("bounds gateway health probes with a 900ms timeout", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );

    await expect(probeGatewayUrl("ws://127.0.0.1:1234")).resolves.toMatchObject({
      reachable: true,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 900);
  });

  it("cancels gateway health response bodies", async () => {
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            statusText: "Service Unavailable",
            body: { cancel },
          }) as unknown as Response,
      ),
    );

    await expect(probeGatewayUrl("ws://127.0.0.1:1234")).resolves.toEqual({
      reachable: false,
      url: "ws://127.0.0.1:1234",
      error: "Service Unavailable",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
