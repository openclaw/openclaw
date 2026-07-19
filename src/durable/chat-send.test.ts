import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { recordDurableChatSendIntake, recordDurableChatSendTerminal } from "./chat-send.js";
import { resolveDurableRuntimeSqlitePath } from "./config.js";
import { DURABLE_CHAT_SEND_OPERATION_KIND } from "./runtime-ids.js";
import { openDurableRuntimeStore } from "./store-factory.js";

describe("durable chat send", () => {
  it("is inert when durable runtime is off", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-chat-off-"));
    try {
      recordDurableChatSendIntake({
        runId: "chat-off",
        sessionKey: "agent:main:main",
        message: "do not persist",
        attachmentCount: 0,
        config: { mode: "off" },
        env: { ...process.env, OPENCLAW_STATE_DIR: dir },
      });
      expect(fs.existsSync(path.join(dir, "openclaw.sqlite"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists metadata-only intake and one terminal settlement", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-chat-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const config = { mode: "observe" } as const;
    try {
      recordDurableChatSendIntake({
        runId: "chat-1",
        sessionKey: "agent:main:main",
        agentId: "main",
        message: "private prompt text",
        attachmentCount: 1,
        config,
        env,
        now: 100,
      });
      recordDurableChatSendTerminal({
        runId: "chat-1",
        sessionKey: "agent:main:main",
        agentId: "main",
        status: "succeeded",
        summary: "completed",
        config,
        env,
        now: 200,
      });

      const store = openDurableRuntimeStore({ env });
      try {
        const run = store.getRunByIdempotencyKey(DURABLE_CHAT_SEND_OPERATION_KIND, "chat-1");
        expect(run).toMatchObject({ status: "succeeded", recoveryState: "terminal" });
        expect(JSON.stringify(run)).not.toContain("private prompt text");
        expect(store.getTimeline(run!.runtimeRunId).map((event) => event.eventType)).toEqual([
          "chat.send.received",
          "chat.send.succeeded",
        ]);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails before acceptance when authority cannot persist the intake bundle", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-chat-authority-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const store = openDurableRuntimeStore({ env });
    store.close();
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolveDurableRuntimeSqlitePath(env));
    try {
      db.exec(`
        CREATE TRIGGER abort_chat_send_received_event
        BEFORE INSERT ON durable_event_evidence
        WHEN NEW.event_type = 'chat.send.received'
        BEGIN
          SELECT RAISE(ABORT, 'fault-injected chat intake event');
        END;
      `);
    } finally {
      db.close();
    }

    try {
      expect(() =>
        recordDurableChatSendIntake({
          runId: "chat-authority-failure",
          sessionKey: "agent:main:main",
          message: "must not be acknowledged",
          attachmentCount: 0,
          config: { mode: "authority" },
          env,
        }),
      ).toThrow(/fault-injected chat intake event/);
      const verify = openDurableRuntimeStore({ env });
      try {
        expect(verify.listRuns()).toEqual([]);
      } finally {
        verify.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
