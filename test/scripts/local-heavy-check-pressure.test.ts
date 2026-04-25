import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importActual) => ({
  ...(await importActual<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

const { getLocalHeavyCheckPressureError } =
  await import("../../scripts/lib/local-heavy-check-runtime.mjs");

const { createTempDir } = createScriptTestHarness();

describe("local heavy-check pressure guard", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("checks pressure on the effective heavy-check temp directory", () => {
    const cwd = createTempDir("openclaw-heavy-check-pressure-");
    const tempDir = path.join(cwd, ".heavy-check-tmp");

    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: [
        "Filesystem 1024-blocks Used Available Capacity Mounted on",
        "/dev/fake 1024000 921600 102400 90% /fake-heavy-tmp",
      ].join("\n"),
    });

    expect(
      getLocalHeavyCheckPressureError({
        cwd,
        env: {
          OPENCLAW_LOCAL_HEAVY_CHECK_TMPDIR: tempDir,
          OPENCLAW_HEAVY_CHECK_MIN_MEM_AVAILABLE_BYTES: "1",
          OPENCLAW_HEAVY_CHECK_MIN_TMP_AVAILABLE_BYTES: `${1024 * 1024 ** 2}`,
        },
      }),
    ).toContain("temp directory available 100 MiB is below 1.0 GiB");

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "df",
      ["-Pk", tempDir],
      expect.objectContaining({ cwd }),
    );
  });
});
