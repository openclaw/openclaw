import { beforeEach, describe, expect, it, vi } from "vitest";
import { withHandedOffCodexClientVersion } from "./codex-client-version-handoff.internal.js";
import { resolveCodexClientVersion } from "./codex-client-version-runtime.js";
import type * as FacadeRuntime from "./facade-runtime.js";

const tryLoadActivatedBundledPluginPublicSurfaceModule = vi.hoisted(() => vi.fn());
vi.mock("./facade-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof FacadeRuntime>()),
  tryLoadActivatedBundledPluginPublicSurfaceModule,
}));

// What the Codex plugin would select if this process probed PATH itself.
const ownSelection = vi.fn(async () => "0.170.0");

describe("resolveCodexClientVersion", () => {
  beforeEach(() => {
    ownSelection.mockClear();
    tryLoadActivatedBundledPluginPublicSurfaceModule
      .mockReset()
      .mockResolvedValue({ resolveCodexClientVersion: ownSelection });
  });

  it.each([
    { handedOff: "0.162.1", reported: "0.162.1" },
    // The parent rejected or never selected an installed Codex: report the bundled pin.
    { handedOff: undefined, reported: undefined },
  ])(
    "reports the parent's decision $handedOff inside a catalog worker request",
    async ({ handedOff, reported }) => {
      await expect(
        withHandedOffCodexClientVersion(handedOff, () => resolveCodexClientVersion({ env: {} })),
      ).resolves.toBe(reported);
      expect(tryLoadActivatedBundledPluginPublicSurfaceModule).not.toHaveBeenCalled();
      expect(ownSelection).not.toHaveBeenCalled();
    },
  );

  it("asks the Codex plugin in the process that runs Codex turns", async () => {
    const env = {};

    await expect(resolveCodexClientVersion({ env })).resolves.toBe("0.170.0");
    expect(tryLoadActivatedBundledPluginPublicSurfaceModule).toHaveBeenCalledExactlyOnceWith({
      dirName: "codex",
      artifactBasename: "client-version-api.js",
    });
    expect(ownSelection).toHaveBeenCalledExactlyOnceWith({ env });
  });

  it("reports nothing when the Codex plugin surface fails to load", async () => {
    tryLoadActivatedBundledPluginPublicSurfaceModule.mockRejectedValueOnce(new Error("inactive"));

    await expect(resolveCodexClientVersion({ env: {} })).resolves.toBeUndefined();
  });
});
