import { afterEach, describe, expect, it, vi } from "vitest";
import { escapeHtml, runChannelProbe } from "./text-utility-runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("escapeHtml", () => {
  it("escapes five HTML-sensitive characters and existing entity markers", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml("already &amp; escaped")).toBe("already &amp;amp; escaped");
  });
});

describe("runChannelProbe", () => {
  it.each([
    { clockOffset: 60_000, succeeds: true },
    { clockOffset: -60_000, succeeds: false },
  ])("measures elapsed time across a wall-clock step: %j", async ({ clockOffset, succeeds }) => {
    const epoch = 1_700_000_000_000;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(epoch)
      .mockReturnValue(epoch + clockOffset);
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(145);

    const result = await runChannelProbe(
      undefined,
      async ({ startedAt }) => {
        expect(startedAt).toBe(epoch);
        if (!succeeds) {
          throw new Error("probe failed");
        }
        return { ok: true };
      },
      (error) => ({ ok: false, error: String(error) }),
    );

    expect(result).toEqual(
      succeeds
        ? { ok: true, elapsedMs: 45 }
        : { ok: false, error: "Error: probe failed", elapsedMs: 45 },
    );
  });

  it("preserves an explicit timing snapshot", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValue(-59_900);
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(120)
      .mockReturnValue(145);

    await expect(
      runChannelProbe(
        undefined,
        async ({ elapsedMs }) => ({ ok: true, elapsedMs: elapsedMs() }),
        (error) => ({ ok: false, error: String(error) }),
      ),
    ).resolves.toEqual({ ok: true, elapsedMs: 20 });
  });

  it("applies the timeout before shaping the error result", async () => {
    vi.useFakeTimers();
    const resultPromise = runChannelProbe(
      50,
      async () => await new Promise<never>(() => {}),
      (error) => ({ ok: false, error: String(error) }),
    );

    await vi.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Error: timeout",
      elapsedMs: 50,
    });
  });
});
