import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

it("delivers critical memory pressure to a subscriber that joins after collection", async ({
  signal,
}) => {
  const root = fixture.createTempDir("openclaw-diagnostic-channel-retention-");
  const result = await fixture.track(
    runNodeScript(
      (workerArgv) => [
        "--expose-gc",
        ...workerArgv(new URL("./diagnostic-channel-retention.test-support.ts", import.meta.url)),
      ],
      { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root, NODE_OPTIONS: "" },
      undefined,
      {
        signal,
        executable: process.execPath,
        requireProcessTreeExit: process.platform !== "win32",
      },
    ),
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ delivered: 1 });
});
