import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOagChannelHealthSummary } from "./oag-channel-health.js";

describe("readOagChannelHealthSummary", () => {
  let tempHome: string | undefined;
  const previousHome = process.env.HOME;

  afterEach(async () => {
    process.env.HOME = previousHome;
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it("parses affected_targets fields in snake_case", async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oag-health-"));
    process.env.HOME = tempHome;
    const sentinelDir = path.join(tempHome, ".openclaw", "sentinel");
    await fs.mkdir(sentinelDir, { recursive: true });
    await fs.writeFile(
      path.join(sentinelDir, "channel-health-state.json"),
      JSON.stringify(
        {
          congested: true,
          affected_channels: ["telegram"],
          pending_deliveries: 2,
          recent_failure_count: 1,
          affected_targets: [
            {
              channel: "telegram",
              account_id: "ops",
              session_keys: ["telegram:direct:ops"],
              pending_deliveries: 2,
              recent_failures: 1,
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const summary = await readOagChannelHealthSummary();
    expect(summary?.affectedTargets).toEqual([
      {
        channel: "telegram",
        accountId: "ops",
        sessionKeys: ["telegram:direct:ops"],
        pendingDeliveries: 2,
        recentFailures: 1,
      },
    ]);
  });
});
