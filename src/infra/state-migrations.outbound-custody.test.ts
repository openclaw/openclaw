import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const child = fileURLToPath(
  new URL("./state-migrations.outbound-custody.child.test-support.ts", import.meta.url),
);

it.for(["success", "callback-failure", "retained-release", "retained-acquire"])(
  "Doctor keeps physical exclusion until plugin resource settlement: %s",
  { timeout: 70_000 },
  async (mode, { signal }) => {
    const stateDir = temporary.make("openclaw-doctor-plugin-custody-");
    const result = await runNodeScript(
      ["--import", "tsx", child, stateDir, mode],
      {
        ...process.env,
        HOME: stateDir,
        USERPROFILE: stateDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_HOME: stateDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
      60_000,
      { signal, requireProcessTreeExit: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    expect(report).toEqual({
      blocked: mode.startsWith("retained"),
      writable: mode.startsWith("retained"),
      outcome: mode === "success" ? "completed" : "refused",
    });
  },
);
