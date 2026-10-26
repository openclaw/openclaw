import { readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { launchTalkObservationBrowser } from "../../scripts/lib/control-ui-talk-fixture.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it("rejects a missing browser executable and reclaims its temporary profile", async () => {
  const artifacts = tempDirs.make("openclaw-talk-browser-");
  vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", path.join(artifacts, "missing-chromium"));

  await expect(launchTalkObservationBrowser(artifacts, true)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(readdirSync(artifacts)).toEqual([]);
}, 5_000);
