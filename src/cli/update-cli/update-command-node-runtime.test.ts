import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findUsableNodeRuntime } from "../../../node-runtime-recovery.mjs";
import { resolveTargetNodeRuntime } from "./update-command-node-runtime-resolution.js";

vi.mock("../../../node-runtime-recovery.mjs", () => ({ findUsableNodeRuntime: vi.fn() }));
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  ["installed", undefined, 30_000],
  ["discovery", undefined, 30_000],
  ["discovery", 120_000, 120_000],
  ["discovery", 2_000, 2_000],
  ["no compatible release", undefined, 30_000],
  ["upstream unavailable", undefined, 30_000],
  ["oversized response", undefined, 30_000],
] as const)(
  "resolves a verified runtime: %s (timeout=%s)",
  async (scenario, timeoutMs, expectedTimeout) => {
    const installed = scenario === "installed";
    const discovery = scenario === "discovery";
    const installCommand = installed ? undefined : vi.fn();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(findUsableNodeRuntime)
      .mockResolvedValue(null)
      .mockResolvedValueOnce(installed ? { nodePath: "/owned/node26", reason: "PATH" } : null);
    if (discovery) {
      vi.mocked(findUsableNodeRuntime).mockResolvedValueOnce({
        nodePath: "/owned/private-node",
        reason: "private runtime",
      });
    }
    const releases = discovery
      ? ["v28.2.0", "v26.1.0", "v27.9.0", "v26.8.1", "v24.20.0", "invalid", null]
      : ["v24.20.0", "v27.9.0"];
    fetchMock.mockResolvedValue(
      scenario === "upstream unavailable"
        ? new Response("unavailable", { status: 503 })
        : new Response(
            scenario === "oversized response"
              ? "x".repeat(2 * 1024 * 1024 + 1)
              : JSON.stringify(releases.map((version) => (version === null ? null : { version }))),
          ),
    );
    expect(
      await resolveTargetNodeRuntime({
        engine: installed || discovery ? ">=26.1.0" : ">=26.1.0 <27",
        timeoutMs,
        recovery: { env: {}, installCommand },
      }),
    ).toBe(installed ? "/owned/node26" : discovery ? "/owned/private-node" : undefined);
    if (installed) {
      expect(fetchMock).not.toHaveBeenCalled();
    } else {
      expect(timeout).toHaveBeenCalledWith(expectedTimeout);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
    expect(findUsableNodeRuntime).toHaveBeenCalledTimes(discovery ? 2 : 1);
    if (discovery) {
      const selected = vi.mocked(findUsableNodeRuntime).mock.calls[1]?.[0];
      expect(selected).toMatchObject({ allowInstall: true, nodeVersion: "26.8.1", installCommand });
      expect(selected?.acceptVersion?.("24.20.0")).toBe(false);
      expect(selected?.acceptVersion?.("26.8.1")).toBe(true);
    }
  },
);
