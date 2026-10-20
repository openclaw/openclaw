import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "./helpers/run-node-script.js";

it.skipIf(process.platform === "win32")(
  "reviews bounded private evidence through real Codex without persisting a native conversation",
  { timeout: 180_000 },
  async ({ signal }) => {
    // Source-only host and plugins share module-local admission authority; a built
    // worker plus source-loaded SDK would create a second owner.
    const result = await runNodeScript(
      ["--import", "./scripts/tsx.mjs", "test/workshop-codex-native.child.ts"],
      { ...process.env, NODE_OPTIONS: "" },
      160_000,
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        signal,
        maxBuffer: 64 * 1024,
        requireProcessTreeExit: true,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("WORKSHOP_NATIVE_PROOF_OK");
  },
);
