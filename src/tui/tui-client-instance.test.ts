import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadOrCreateTuiInstanceId,
  resolveDefaultTuiSessionKey,
  resolveTuiInstanceFilePath,
  resolveTuiInstanceSlot,
} from "./tui-client-instance.js";

describe("tui client instance state", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses terminal slot metadata when available", () => {
    expect(
      resolveTuiInstanceSlot({
        TMUX_PANE: "%17",
      } as NodeJS.ProcessEnv),
    ).toBe("tmux_pane:%17");
  });

  it("persists a stable instance id per slot", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-instance-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("TMUX_PANE", "%19");

    try {
      const first = loadOrCreateTuiInstanceId({
        randomId: () => "fixture-id",
      });
      const second = loadOrCreateTuiInstanceId({
        randomId: () => "different-id",
      });

      expect(first).toBe("tui-fixture-id");
      expect(second).toBe(first);
      const filePath = resolveTuiInstanceFilePath(process.env);
      const persisted = JSON.parse(await fs.readFile(filePath, "utf-8")) as { id?: string };
      expect(persisted.id).toBe(first);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses different files for different slots", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-instance-slots-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    try {
      vi.stubEnv("TMUX_PANE", "%1");
      const first = loadOrCreateTuiInstanceId({
        randomId: () => "slot-one",
      });
      vi.stubEnv("TMUX_PANE", "%2");
      const second = loadOrCreateTuiInstanceId({
        randomId: () => "slot-two",
      });

      expect(first).toBe("tui-slot-one");
      expect(second).toBe("tui-slot-two");
      expect(second).not.toBe(first);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("builds a stable default affinity session key", () => {
    expect(
      resolveDefaultTuiSessionKey({
        currentAgentId: "main",
        sessionMainKey: "main",
        clientInstanceId: "tui-123",
      }),
    ).toBe("agent:main:tui:main:tui-123");
  });
});
