import "../src/test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

it.each([
  { args: ["click", " "], message: "ref is required" },
  { args: ["click-coords", "NaN", "10"], message: "Invalid x: must be a finite number" },
  {
    args: ["batch", "--actions", "[]", "--actions-file", "missing.json"],
    message: "Specify only one of --actions or --actions-file",
  },
  { args: ["evaluate"], message: "Missing --fn" },
  {
    args: ["dialog", "--accept", "--dismiss"],
    message: "Specify only one of --accept or --dismiss",
  },
  { args: ["batch"], message: "Provide --actions" },
])("renders browser local validation as one JSON failure: $args", async ({ args, message }) => {
  await withTempHome(
    async (home) => {
      const result = runBuiltCli(
        home,
        ["browser", "--json", ...args],
        {
          OPENCLAW_STATE_DIR: path.join(home, "state"),
          OPENCLAW_CONFIG_PATH: path.join(home, "missing.json"),
        },
        { inheritEnvironment: false },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { type: "cli_error", message: expect.stringContaining(message) },
      });
      // Preserve the baseline top-level human diagnostic alongside JSON stdout.
      expect(result.stderr.trim()).toBe(
        message === "Provide --actions"
          ? "Provide --actions, --actions-file, or --actions-file -"
          : message,
      );
    },
    { prefix: "browser-json-validation-" },
  );
});
