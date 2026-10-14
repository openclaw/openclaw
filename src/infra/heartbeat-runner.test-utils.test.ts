import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

it("restores the heartbeat sandbox when real scratch storage setup fails", async () => {
  // The outer scope rescues leaked state when this runs against the broken helper.
  await withTempDir("openclaw-hb-setup-", async (outer) => {
    // openclaw-temp-dir: allow verifies cleanup of a real obstructed sandbox
    const sandbox = await fs.mkdtemp(path.join(await fs.realpath(outer), "sandbox-"));
    const obstruction = path.join(sandbox, "state", "state");
    await fs.mkdir(path.dirname(obstruction));
    await fs.writeFile(obstruction, "owned obstruction", { flag: "wx" });
    const outerState = path.join(outer, "state-owner");
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: outerState,
        TELEGRAM_BOT_TOKEN: "synthetic-heartbeat-token",
      },
      async () => {
        const callback = vi.fn(async () => undefined);
        const directoryCreation = vi.spyOn(fs, "mkdtemp").mockResolvedValueOnce(sandbox);
        try {
          await expect(
            withTempHeartbeatSandbox(callback, {
              unsetEnvVars: ["TELEGRAM_BOT_TOKEN", "OPENCLAW_STATE_DIR", "TELEGRAM_BOT_TOKEN"],
            }),
          ).rejects.toMatchObject({
            // Keep the owned filesystem failure independent of platform/probe errno.
            code: expect.any(String),
            syscall: expect.any(String),
            path: expect.stringContaining(obstruction),
          });
          expect(callback).not.toHaveBeenCalled();
          expect({
            state: process.env.OPENCLAW_STATE_DIR,
            token: process.env.TELEGRAM_BOT_TOKEN,
            directoryExists: existsSync(sandbox),
          }).toEqual({
            state: outerState,
            token: "synthetic-heartbeat-token",
            directoryExists: false,
          });
        } finally {
          directoryCreation.mockRestore();
          closeOpenClawStateDatabaseForTest();
        }
      },
    );
  });
});
