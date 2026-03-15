import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

function createConfig(tmpDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: tmpDir,
        heartbeat: {
          every: "5m",
          target: "none",
        },
      },
    },
    session: {
      store: path.join(tmpDir, "sessions.json"),
    },
  };
}

describe("runHeartbeatOnce empty HEARTBEAT.md guard", () => {
  it("does not block interval heartbeats when pending system events exist", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-pending-events-"));
    try {
      await fs.writeFile(
        path.join(tmpDir, DEFAULT_HEARTBEAT_FILENAME),
        "# HEARTBEAT.md\n\n## Tasks\n\n",
        "utf-8",
      );

      const cfg = createConfig(tmpDir);
      const sessionKey = resolveMainSessionKey(cfg);
      enqueueSystemEvent("Profile wake ping", { sessionKey });

      const getReplySpy = vi
        .spyOn(replyModule, "getReplyFromConfig")
        .mockResolvedValue({ text: "Processed pending system event" });

      const result = await runHeartbeatOnce({ cfg, reason: "interval" });

      expect(result.status).toBe("ran");
      expect(getReplySpy).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("still skips interval heartbeats for empty HEARTBEAT.md when no pending events exist", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-no-pending-events-"));
    try {
      await fs.writeFile(
        path.join(tmpDir, DEFAULT_HEARTBEAT_FILENAME),
        "# HEARTBEAT.md\n\n## Tasks\n\n",
        "utf-8",
      );

      const cfg = createConfig(tmpDir);

      const getReplySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      const result = await runHeartbeatOnce({ cfg, reason: "interval" });

      expect(result.status).toBe("skipped");
      if (result.status === "skipped") {
        expect(result.reason).toBe("empty-heartbeat-file");
      }
      expect(getReplySpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
