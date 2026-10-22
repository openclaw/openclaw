import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readChildRuntimeViability } from "./child-runtime-viability.js";
import { claimTailscaleRoute } from "./tailscale.js";

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: vi.fn(async () => ({
    stdout: JSON.stringify({ BackendState: "Running", Web: {} }),
    stderr: "",
  })),
}));

it.skipIf(process.platform === "win32")(
  "reports a removed runtime through route startup after native exec failure closes",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-route-runtime-"));
    const executable = process.execPath;
    vi.stubEnv("OPENCLAW_TEST_TAILSCALE_BINARY", "fixture-tailscale");
    try {
      process.execPath = path.join(directory, "removed-node");
      await expect(claimTailscaleRoute("serve", 45000, 45001, () => {})).rejects.toMatchObject({
        code: "NODE_RUNTIME_UNAVAILABLE",
        message: expect.stringContaining("Restart the Gateway."),
      });
      expect(readChildRuntimeViability().available).toBe(false);
    } finally {
      process.execPath = executable;
      vi.unstubAllEnvs();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
