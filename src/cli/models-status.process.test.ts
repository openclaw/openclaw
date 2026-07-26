// Real source CLI processes prove status stays read-only under SQLite contention.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CHILD_PROCESS_TIMEOUT_MS = 90_000;

async function createModelsStatusFixture() {
  const root = tempDirs.make("openclaw-models-status-process-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, "{}\n");

  // Seed the canonical store: readers must not contend on a repair transaction.
  const database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  closeOpenClawStateDatabaseByPath(database.path);

  return { root, stateDir, configPath };
}

async function runModelsStatusProcess(
  fixture: Awaited<ReturnType<typeof createModelsStatusFixture>>,
  args: string[],
) {
  const result = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "src/entry.ts", ...args],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fixture.root,
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        NODE_NO_WARNINGS: "1",
        OPENCLAW_CONFIG_PATH: fixture.configPath,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_STATE_DIR: fixture.stateDir,
        VITEST: undefined,
      },
      killSignal: "SIGKILL",
      timeout: CHILD_PROCESS_TIMEOUT_MS,
    },
  );

  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ configPath: fixture.configPath });
}

describe("model status source CLI process", () => {
  it("emits clean machine-readable stdout for all parent and canonical status forms", async () => {
    const fixture = await createModelsStatusFixture();
    const variants = [
      ["models", "--status-json"],
      ["models", "status", "--json"],
      ["models", "--agent", "main", "--status-json"],
      ["models", "--status-json", "--agent", "main"],
      ["models", "--agent=main", "--status-json"],
      ["models", "--agent", "main", "status", "--json"],
      ["models", "--agent=main", "status", "--json"],
    ];

    await Promise.all(variants.map((args) => runModelsStatusProcess(fixture, args)));
  }, 120_000);

  it.each([1, 2, 4])(
    "keeps %i real status processes read-only against one shared state database",
    async (processCount) => {
      const fixture = await createModelsStatusFixture();

      await Promise.all(
        Array.from({ length: processCount }, () =>
          runModelsStatusProcess(fixture, ["models", "--status-json"]),
        ),
      );
    },
    120_000,
  );
});
