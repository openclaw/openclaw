import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSpawnBrokerHost } from "./host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("spawn broker startup failure", () => {
  it("settles shutdown when the broker executable could not be launched", async () => {
    const executable = process.execPath;
    let host: ReturnType<typeof createSpawnBrokerHost>;
    try {
      process.execPath = path.join(tempDirs.make("openclaw-broker-missing-"), "node");
      host = createSpawnBrokerHost();
    } finally {
      process.execPath = executable;
    }
    await expect(host.ready()).rejects.toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
    await withTestTimeout(host.close(), 1_000, "broker shutdown waited for an uncreated process");
  });
});
