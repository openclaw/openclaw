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
  it.each([false, true])("times probes across wall steps (explicit=%s)", async (explicit) => {
    const epoch = 1_700_000_000_000;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(epoch)
      .mockReturnValue(epoch + (explicit ? -60_000 : 60_000));
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValue(explicit ? 120 : 145);
    await expect(
      runChannelProbe(
        undefined,
        async ({ startedAt, elapsedMs }) => ({
          ok: startedAt === epoch,
          ...(explicit ? { elapsedMs: elapsedMs() } : {}),
        }),
        (error) => ({ ok: false, error: String(error) }),
      ),
    ).resolves.toEqual({ ok: true, elapsedMs: explicit ? 20 : 45 });
  });

  it("applies the timeout before shaping the error result", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const resultPromise = runChannelProbe(
      50,
      async () => await new Promise<never>(() => {}),
      (error) => ({ ok: false, error: String(error) }),
    );
    vi.setSystemTime(Date.now() - 60_000);

    await vi.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Error: timeout",
      elapsedMs: 50,
    });
  });
});
