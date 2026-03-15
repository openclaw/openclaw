import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRestartSentinel } from "../../infra/restart-sentinel.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { writeRestartSentinelFromEnvIfPresent } from "./restart-notify.js";

describe("writeRestartSentinelFromEnvIfPresent", () => {
  it("writes a restart sentinel when restart notify env is present", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-notify-"));
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_RESTART_NOTIFY_SESSION_KEY: "agent:main:feishu:direct:ou_123",
          OPENCLAW_RESTART_NOTIFY_CHANNEL: "feishu",
          OPENCLAW_RESTART_NOTIFY_TO: "user:ou_123",
          OPENCLAW_RESTART_NOTIFY_MESSAGE: "restart finished",
        },
        async () => {
          await expect(writeRestartSentinelFromEnvIfPresent(process.env)).resolves.toBe(true);
          const sentinel = await readRestartSentinel(process.env);
          expect(sentinel?.payload.sessionKey).toBe("agent:main:feishu:direct:ou_123");
          expect(sentinel?.payload.deliveryContext).toMatchObject({
            channel: "feishu",
            to: "user:ou_123",
          });
          expect(sentinel?.payload.message).toBe("restart finished");
        },
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("returns false instead of throwing when writing the sentinel fails", async () => {
    const stateFile = path.join(os.tmpdir(), `openclaw-restart-notify-file-${Date.now()}`);
    await fs.writeFile(stateFile, "occupied", "utf-8");
    try {
      await expect(
        writeRestartSentinelFromEnvIfPresent({
          OPENCLAW_STATE_DIR: stateFile,
          OPENCLAW_RESTART_NOTIFY_SESSION_KEY: "agent:main:feishu:direct:ou_123",
        } as NodeJS.ProcessEnv),
      ).resolves.toBe(false);
    } finally {
      await fs.rm(stateFile, { force: true });
    }
  });

  it("is a no-op when restart notify env is absent", async () => {
    await expect(writeRestartSentinelFromEnvIfPresent({} as NodeJS.ProcessEnv)).resolves.toBe(
      false,
    );
  });
});
