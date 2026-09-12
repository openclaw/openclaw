import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findUsableNodeRuntime } from "../../../node-runtime-recovery.mjs";
import { resolveTargetNodeRuntime } from "./update-command-node-runtime-resolution.js";

vi.mock("../../../node-runtime-recovery.mjs", () => ({ findUsableNodeRuntime: vi.fn() }));
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it("uses an installed target-compatible runtime without fetching or provisioning", async () => {
  vi.mocked(findUsableNodeRuntime).mockResolvedValue({ nodePath: "/owned/node26", reason: "PATH" });
  expect(await resolveTargetNodeRuntime({ engine: ">=26.1.0", recovery: { env: {} } })).toBe(
    "/owned/node26",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it("selects an exact compatible even release from unordered upstream metadata", async () => {
  const installCommand = vi.fn();
  vi.mocked(findUsableNodeRuntime)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ nodePath: "/owned/private-node", reason: "private runtime" });
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify([
        { version: "v28.2.0" },
        { version: "v26.1.0" },
        { version: "v27.9.0" },
        { version: "v26.8.1" },
        { version: "v24.20.0" },
        { version: "invalid" },
        null,
      ]),
    ),
  );
  expect(
    await resolveTargetNodeRuntime({ engine: ">=26.1.0", recovery: { env: {}, installCommand } }),
  ).toBe("/owned/private-node");
  const selected = vi.mocked(findUsableNodeRuntime).mock.calls[1]?.[0];
  expect(selected).toMatchObject({ allowInstall: true, nodeVersion: "26.8.1", installCommand });
  expect(selected?.acceptVersion?.("24.20.0")).toBe(false);
  expect(selected?.acceptVersion?.("26.8.1")).toBe(true);
});

it.each(["no compatible release", "upstream unavailable", "oversized response"] as const)(
  "does not install an unverified target when %s",
  async (scenario) => {
    vi.mocked(findUsableNodeRuntime).mockResolvedValue(null);
    fetchMock.mockResolvedValue(
      scenario === "upstream unavailable"
        ? new Response("unavailable", { status: 503 })
        : new Response(
            scenario === "oversized response"
              ? "x".repeat(2 * 1024 * 1024 + 1)
              : JSON.stringify([{ version: "v24.20.0" }, { version: "v27.9.0" }]),
          ),
    );
    expect(
      await resolveTargetNodeRuntime({
        engine: ">=26.1.0 <27",
        recovery: { env: {}, installCommand: vi.fn() },
      }),
    ).toBeUndefined();
    expect(findUsableNodeRuntime).toHaveBeenCalledOnce();
  },
);
