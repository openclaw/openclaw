import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterAll);
const child = fileURLToPath(
  new URL("./state-migrations.outbound-custody.child.test-support.ts", import.meta.url),
);

type Report = {
  mode: string;
  blocked: boolean;
  writable: boolean;
  outcome: string;
};

let reports: Report[] = [];

beforeAll(async () => {
  const stateDir = temporary.make("openclaw-doctor-plugin-custody-");
  const result = await runNodeScript(
    ["--import", "tsx", child, stateDir, "all"],
    {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
    90_000,
    { requireProcessTreeExit: true },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  reports = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Report[];
}, 100_000);

it.for(["success", "callback-failure", "retained-release", "retained-acquire"])(
  "Doctor keeps physical exclusion until plugin resource settlement: %s",
  { timeout: 70_000 },
  async (mode) => {
    const report = reports.find((entry) => entry.mode === mode);
    expect(report).toBeDefined();
    expect(report).toEqual({
      mode,
      blocked: mode.startsWith("retained"),
      writable: mode.startsWith("retained"),
      outcome: mode === "success" ? "completed" : "refused",
    });
  },
);
