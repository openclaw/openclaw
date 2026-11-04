import { afterEach, expect, it, vi } from "vitest";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([401, 429, 200, undefined])(
  "reports only the HTTP status for a failed cache probe (%s)",
  async (status) => {
    vi.resetModules();
    process.argv = [process.execPath, "anthropic-cache-live.mts", "--provider", "openrouter"];
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-private-key");
    const fetchMock = vi.fn(async () => {
      if (status === undefined) {
        throw new TypeError("synthetic-private-network-error");
      }
      return Response.json(
        { error: { code: 429, message: "synthetic-private-error-body" } },
        { status, headers: { "x-private-header": "synthetic-private-header" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    let failure: unknown;
    try {
      await import("../../scripts/e2e/anthropic-cache-live.mts");
    } catch (error) {
      failure = error;
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(Error);
    const output = [String(failure), ...stdout.mock.calls.map(([chunk]) => String(chunk))].join(
      "\n",
    );
    expect(output).toContain(
      `openrouter/initial: provider request failed (error, HTTP ${status ?? "unobserved"})`,
    );
    expect(output).not.toContain("synthetic-private");
  },
);
