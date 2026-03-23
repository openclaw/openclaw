import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setWhatsAppRuntime } from "../../extensions/whatsapp/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { resetSystemEventsForTest, enqueueSystemEvent } from "./system-events.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

let fixtureRoot = "";
let fixtureCount = 0;

const createCaseDir = async (prefix: string) => {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

const createHeartbeatDeps = (
  sendWhatsApp?: NonNullable<HeartbeatDeps["sendWhatsApp"]>,
  nowMs = 0,
): HeartbeatDeps => ({
  sendWhatsApp,
  getQueueSize: () => 0,
  nowMs: () => nowMs,
  webAuthExists: async () => true,
  hasActiveWebListener: () => true,
});

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-before-run-"));
});

beforeEach(() => {
  resetSystemEventsForTest();
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setWhatsAppRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function writeGateScript(dir: string, exitCode: number): Promise<string> {
  const scriptPath = path.join(dir, `gate-${exitCode}.sh`);
  await fs.writeFile(scriptPath, `#!/usr/bin/env bash\nexit ${exitCode}\n`, { mode: 0o755 });
  return scriptPath;
}

async function setupHeartbeatScenario(params: {
  beforeRun?: string;
  reason?: "interval" | "wake" | "exec-event";
  queueCronEvent?: boolean;
}) {
  const tmpDir = await createCaseDir("before-run");
  const storePath = path.join(tmpDir, "sessions.json");
  await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "- Check status\n", "utf-8");

  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: tmpDir,
        heartbeat: {
          every: "5m",
          target: "whatsapp",
          ...(params.beforeRun !== undefined ? { beforeRun: params.beforeRun } : {}),
        },
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
  const sessionKey = resolveMainSessionKey(cfg);
  await fs.writeFile(
    storePath,
    JSON.stringify({
      [sessionKey]: {
        sessionId: "sid",
        updatedAt: Date.now(),
        lastChannel: "whatsapp",
        lastTo: "120363401234567890@g.us",
      },
    }),
  );

  if (params.queueCronEvent) {
    enqueueSystemEvent("Cron: maintenance", { sessionKey, contextKey: "cron:maint" });
  }

  return { cfg, tmpDir, sessionKey };
}

describe("runHeartbeatOnce – beforeRun gate", () => {
  it("skips heartbeat when beforeRun script exits non-zero", async () => {
    const tmpDir = await createCaseDir("gate-reject");
    const script = await writeGateScript(tmpDir, 1);
    const { cfg } = await setupHeartbeatScenario({ beforeRun: script });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
    });
    try {
      const res = await runHeartbeatOnce({ cfg, deps: createHeartbeatDeps(sendWhatsApp) });
      expect(res.status).toBe("skipped");
      if (res.status === "skipped") {
        expect(res.reason).toBe("before-run-gate");
      }
      expect(replySpy).not.toHaveBeenCalled();
      expect(sendWhatsApp).not.toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
    }
  });

  it("proceeds when beforeRun script exits 0", async () => {
    const tmpDir = await createCaseDir("gate-pass");
    const script = await writeGateScript(tmpDir, 0);
    const { cfg } = await setupHeartbeatScenario({ beforeRun: script });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue([{ text: "Alert" }]);
    const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
    });
    try {
      const res = await runHeartbeatOnce({ cfg, deps: createHeartbeatDeps(sendWhatsApp) });
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
    }
  });

  it("bypasses beforeRun gate for wake-triggered heartbeats", async () => {
    const tmpDir = await createCaseDir("gate-wake");
    const script = await writeGateScript(tmpDir, 1);
    const { cfg } = await setupHeartbeatScenario({ beforeRun: script, reason: "wake" });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue([{ text: "Wake response" }]);
    const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
    });
    try {
      const res = await runHeartbeatOnce({
        cfg,
        reason: "wake",
        deps: createHeartbeatDeps(sendWhatsApp),
      });
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
    }
  });

  it("bypasses beforeRun gate for exec-event-triggered heartbeats", async () => {
    const tmpDir = await createCaseDir("gate-exec");
    const script = await writeGateScript(tmpDir, 1);
    const { cfg, sessionKey } = await setupHeartbeatScenario({
      beforeRun: script,
      reason: "exec-event",
    });
    enqueueSystemEvent("exec finished: backup done", {
      sessionKey,
      contextKey: "exec:backup",
    });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue([{ text: "Exec response" }]);
    const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
    });
    try {
      const res = await runHeartbeatOnce({
        cfg,
        reason: "exec-event",
        deps: createHeartbeatDeps(sendWhatsApp),
      });
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
    }
  });

  it("bypasses beforeRun gate when cron events are queued", async () => {
    const tmpDir = await createCaseDir("gate-cron");
    const script = await writeGateScript(tmpDir, 1);
    const { cfg } = await setupHeartbeatScenario({
      beforeRun: script,
      reason: "interval",
      queueCronEvent: true,
    });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue([{ text: "Cron response" }]);
    const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
    });
    try {
      const res = await runHeartbeatOnce({
        cfg,
        reason: "interval",
        deps: createHeartbeatDeps(sendWhatsApp),
      });
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
    }
  });

  it("skips heartbeat when beforeRun script exits with code 2 (cooldown)", async () => {
    const tmpDir = await createCaseDir("gate-cooldown");
    const script = await writeGateScript(tmpDir, 2);
    const { cfg } = await setupHeartbeatScenario({ beforeRun: script });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
    });
    try {
      const res = await runHeartbeatOnce({ cfg, deps: createHeartbeatDeps(sendWhatsApp) });
      expect(res.status).toBe("skipped");
      if (res.status === "skipped") {
        expect(res.reason).toBe("before-run-gate");
      }
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
    }
  });

  it("does not invoke beforeRun when config is absent", async () => {
    const { cfg } = await setupHeartbeatScenario({});

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue([{ text: "Normal run" }]);
    const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
    });
    try {
      const res = await runHeartbeatOnce({ cfg, deps: createHeartbeatDeps(sendWhatsApp) });
      expect(res.status).toBe("ran");
    } finally {
      replySpy.mockRestore();
    }
  });

  it("passes workspace dir as first argument to the gate script", async () => {
    const tmpDir = await createCaseDir("gate-arg-check");
    const markerPath = path.join(tmpDir, "arg-received.txt");
    const scriptPath = path.join(tmpDir, "check-arg.sh");
    await fs.writeFile(scriptPath, `#!/usr/bin/env bash\necho "$1" > "${markerPath}"\nexit 0\n`, {
      mode: 0o755,
    });

    const { cfg } = await setupHeartbeatScenario({ beforeRun: scriptPath });
    const expectedWorkspace = cfg.agents!.defaults!.workspace!;

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue([{ text: "OK" }]);
    const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
    });
    try {
      await runHeartbeatOnce({ cfg, deps: createHeartbeatDeps(sendWhatsApp) });
      const receivedArg = (await fs.readFile(markerPath, "utf-8")).trim();
      expect(receivedArg).toBe(expectedWorkspace);
    } finally {
      replySpy.mockRestore();
    }
  });

  it("skips heartbeat when beforeRun script does not exist", async () => {
    const { cfg } = await setupHeartbeatScenario({
      beforeRun: "/nonexistent/path/gate.sh",
    });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const sendWhatsApp = vi.fn<NonNullable<HeartbeatDeps["sendWhatsApp"]>>().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
    });
    try {
      const res = await runHeartbeatOnce({ cfg, deps: createHeartbeatDeps(sendWhatsApp) });
      expect(res.status).toBe("skipped");
      if (res.status === "skipped") {
        expect(res.reason).toBe("before-run-gate");
      }
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
    }
  });
});
