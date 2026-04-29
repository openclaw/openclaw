import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateSessionStore } from "../config/sessions.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  cleanupPluginSessionSchedulerJobs,
  clearPluginHostRuntimeState,
  listPluginSessionSchedulerJobs,
} from "./host-hook-runtime.js";
import { schedulePluginSessionTurn, sendPluginSessionAttachment } from "./host-hook-workflow.js";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  sendMessage: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../agents/tools/gateway.js", () => ({
  callGatewayTool: mocks.callGatewayTool,
}));

vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: mocks.sendMessage,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: mocks.warn,
  }),
}));

describe("plugin host workflow helpers", () => {
  afterEach(() => {
    mocks.callGatewayTool.mockReset();
    mocks.sendMessage.mockReset();
    mocks.warn.mockReset();
    clearPluginHostRuntimeState();
  });

  it("uses provided config when resolving attachment delivery routes", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-plugin-attachment-cfg-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const attachmentPath = path.join(stateDir, "artifact.txt");
    try {
      await fs.writeFile(attachmentPath, "artifact", "utf8");
      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-1",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "webchat",
            to: "webchat:user-123",
            accountId: "default",
            threadId: "thread-1",
          },
        };
        return undefined;
      });
      mocks.sendMessage.mockResolvedValueOnce({ channel: "webchat" });

      await expect(
        sendPluginSessionAttachment({
          origin: "bundled",
          config: { session: { store: storePath } },
          sessionKey: "agent:main:main",
          text: "artifact ready",
          files: [{ path: attachmentPath }],
        }),
      ).resolves.toEqual({
        ok: true,
        channel: "webchat",
        deliveredTo: "webchat:user-123",
        count: 1,
      });

      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "webchat:user-123",
          content: "artifact ready",
          channel: "webchat",
          accountId: "default",
          threadId: "thread-1",
          requesterSessionKey: "agent:main:main",
          mediaUrls: [attachmentPath],
        }),
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("tracks scheduled session turns using cron.add's top-level job id", async () => {
    mocks.callGatewayTool.mockResolvedValueOnce({
      id: "cron-top-level-id",
      payload: {
        id: "payload-body-id",
        kind: "agentTurn",
      },
    });

    await expect(
      schedulePluginSessionTurn({
        pluginId: "scheduler-fixture",
        pluginName: "Scheduler Fixture",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
        },
      }),
    ).resolves.toEqual({
      id: "cron-top-level-id",
      pluginId: "scheduler-fixture",
      sessionKey: "agent:main:main",
      kind: "session-turn",
    });

    expect(listPluginSessionSchedulerJobs()).toEqual([
      {
        id: "cron-top-level-id",
        pluginId: "scheduler-fixture",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
    ]);
  });

  it("attributes scheduler validation warnings to the plugin and schedule", async () => {
    await expect(
      schedulePluginSessionTurn({
        pluginId: "scheduler-fixture",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          name: "wake-soon",
          message: "wake",
          delayMs: 1_000,
          deliveryMode: "unsupported" as never,
        },
      }),
    ).resolves.toBeUndefined();

    expect(mocks.warn).toHaveBeenCalledWith(
      "plugin session turn scheduling failed (pluginId=scheduler-fixture sessionKey=agent:main:main name=wake-soon): unsupported deliveryMode",
    );
  });

  it("rejects negative delay schedules instead of coercing them to immediate wakes", async () => {
    await expect(
      schedulePluginSessionTurn({
        pluginId: "scheduler-fixture",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: -1,
        },
      }),
    ).resolves.toBeUndefined();

    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("keeps scheduled-turn records when cron cleanup fails", async () => {
    mocks.callGatewayTool.mockImplementation(async (method) => {
      if (method === "cron.add") {
        return { id: "cleanup-failure-job" };
      }
      if (method === "cron.remove") {
        throw new Error("cron unavailable");
      }
      return undefined;
    });

    await expect(
      schedulePluginSessionTurn({
        pluginId: "scheduler-fixture",
        pluginName: "Scheduler Fixture",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
        },
      }),
    ).resolves.toMatchObject({ id: "cleanup-failure-job" });

    await expect(
      cleanupPluginSessionSchedulerJobs({
        pluginId: "scheduler-fixture",
        reason: "disable",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        pluginId: "scheduler-fixture",
        hookId: "scheduler:cleanup-failure-job",
      }),
    ]);
    expect(listPluginSessionSchedulerJobs("scheduler-fixture")).toEqual([
      {
        id: "cleanup-failure-job",
        pluginId: "scheduler-fixture",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
    ]);
  });

  it("does not create scheduled turns when the owning plugin generation is already stale", async () => {
    mocks.callGatewayTool.mockImplementation(async (method) => {
      if (method === "cron.add") {
        return { id: "stale-job" };
      }
      return undefined;
    });

    await expect(
      schedulePluginSessionTurn({
        pluginId: "scheduler-fixture",
        pluginName: "Scheduler Fixture",
        origin: "bundled",
        shouldCommit: () => false,
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
        },
      }),
    ).resolves.toBeUndefined();
    expect(listPluginSessionSchedulerJobs("scheduler-fixture")).toEqual([]);
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("fails stale scheduled-turn rollback when cron cleanup fails", async () => {
    let shouldCommit = true;
    mocks.callGatewayTool.mockImplementation(async (method) => {
      if (method === "cron.add") {
        shouldCommit = false;
        return { id: "stale-job" };
      }
      if (method === "cron.remove") {
        throw new Error("cron remove failed");
      }
      return undefined;
    });

    await expect(
      schedulePluginSessionTurn({
        pluginId: "scheduler-fixture",
        pluginName: "Scheduler Fixture",
        origin: "bundled",
        shouldCommit: () => shouldCommit,
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
        },
      }),
    ).rejects.toThrow("failed to remove stale scheduled session turn: stale-job");
    expect(listPluginSessionSchedulerJobs("scheduler-fixture")).toEqual([]);
  });
});
