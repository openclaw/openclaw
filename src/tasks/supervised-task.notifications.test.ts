import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  beginConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliverySent,
  markConversationDeliveryUnknown,
} from "../config/sessions/conversation-delivery-store.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { startSupervisedTaskNotifications } from "./supervised-task.notifications.js";
import { bindSupervisedRootSource } from "./supervised-task.root-source.js";
import { supervisedInputIdentity } from "./supervised-task.source.js";
import {
  createSupervisedTask,
  getSupervisedTask,
  heartbeatTaskSupervisor,
} from "./supervised-task.store.js";
import { readSupervisedWorkflow } from "./supervised-workflow.persistence.js";
const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  send: vi.fn(),
  config: vi.fn(),
  session: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: mocks.config,
}));
vi.mock("../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: mocks.append,
}));
vi.mock("../gateway/session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: mocks.session }));
vi.mock("../gateway/conversation-send.js", () => ({ runGatewayConversationSend: mocks.send }));
const dirs = createTempDirTracker();
let service: ReturnType<typeof startSupervisedTaskNotifications> | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(1000);
  mocks.append.mockReset().mockResolvedValue({ ok: true });
  mocks.send.mockReset().mockResolvedValue({ status: "sent", messageId: "message-one" });
  mocks.config.mockReset().mockReturnValue({});
  mocks.session.mockReset().mockReturnValue({ entry: { sessionId: "session-one" } });
  mocks.error.mockReset();
});
afterEach(() => {
  service?.stop();
  service = undefined;
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
  dirs.cleanup();
});
async function fixture() {
  const root = dirs.make("task-notification-");
  const workspace = `${root}/input`;
  await fs.mkdir(workspace);
  const options = { path: `${root}/state.sqlite` };
  // The configured store must differ from the default agent store: omitting scope
  // otherwise appears correct and misses both route checks and delivery recovery.
  vi.stubEnv("OPENCLAW_STATE_DIR", `${root}/default-state`);
  const config: OpenClawConfig = {
    session: { store: `${root}/configured/{agentId}/sessions.json` },
  };
  mocks.config.mockReturnValue(config);
  const scope = { agentId: "poc", storePath: `${root}/configured/poc/sessions.json` };
  const sessionKey = "agent:poc:discord:channel:ops";
  await upsertSessionEntryCore(
    { ...scope, sessionKey },
    {
      sessionId: "session-one",
      updatedAt: 1000,
      chatType: "channel",
      delivery: {
        kind: "external",
        route: {
          channel: "discord",
          accountId: "default",
          target: { to: "channel:ops", chatType: "channel" },
        },
        context: { channel: "discord", accountId: "default", to: "channel:ops" },
        origin: {
          provider: "discord",
          accountId: "default",
          to: "channel:ops",
          chatType: "channel",
        },
      },
    },
  );
  const source = bindSupervisedRootSource({
    config,
    agentId: "poc",
    sessionKey,
    sessionId: "session-one",
    namespace: "gateway",
    inputId: "input",
  });
  expect(source.conversationRef).toBeDefined();
  heartbeatTaskSupervisor("owner", 1000, 60_000, options);
  const task = createSupervisedTask(
    {
      flowId: "notify",
      agentId: "poc",
      runtime: "codex",
      model: "openai/test",
      prompt: "Repair",
      goal: {
        objective: "Repair",
        success: [{ id: "correct", description: "Correct" }],
        partial: [],
      },
      policy: { deadlineAt: 60_000, attemptTimeoutMs: 10_000, maxAttempts: 4 },
      workflow: {
        version: 1,
        workspace,
        profiles: [],
        sourcePaths: ["."],
        acceptance: [{ kind: "operator", criterionId: "correct" }],
        maxRecoveryAttempts: 3,
        retentionDays: 30,
      },
      admission: { source, ...supervisedInputIdentity(source, "Repair"), assertCurrent: () => {} },
    },
    "owner",
    1000,
    options,
  );
  const row = () =>
    readSupervisedWorkflow(
      (db) =>
        executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<DB>(db)
            .selectFrom("task_flow_notifications")
            .selectAll()
            .where("flow_id", "=", task.flowId),
        ),
      options,
    )!;
  const start = () => {
    service = startSupervisedTaskNotifications({ options, onError: mocks.error });
  };
  const beginDelivery = () =>
    beginConversationDeliveryOperation(scope, {
      operationId: row().notification_id,
      operationKind: "send",
      conversationRef: source.conversationRef!,
      sourceSessionKey: source.sessionKey,
      message: row().content,
    });
  return { options, task, row, start, scope, beginDelivery };
}
it("validates the configured-store source route and records send confirmation independently of the task", async () => {
  const f = await fixture();
  f.start();
  await vi.waitFor(() => expect(f.row().state).toBe("delivered"));
  expect(JSON.parse(f.row().receipt_json!)).toEqual({ messageId: "message-one" });
  expect(getSupervisedTask("notify", f.options)).toEqual(f.task);
  expect(mocks.append.mock.calls[0]?.[0]).toMatchObject({
    expectedSessionId: "session-one",
    idempotencyKey: "supervised:notify:1:accepted",
  });
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
it("recovers a lost configured-store queue response without sending a second platform message", async () => {
  const f = await fixture();
  mocks.send.mockImplementation(async () => {
    f.beginDelivery();
    markConversationDeliveryQueued(f.scope, f.row().notification_id, "queue-one");
    throw new Error("Coordinator lost response after durable enqueue");
  });
  f.start();
  await vi.waitFor(() => expect(f.row().attempts).toBe(1));
  service!.stop();
  vi.setSystemTime(4000);
  f.start();
  await vi.waitFor(() => expect(f.row().state).toBe("queued"));
  markConversationDeliverySent(f.scope, f.row().notification_id, "message-one");
  vi.setSystemTime(10_000);
  await service!.tick();
  expect(f.row().state).toBe("delivered");
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(getSupervisedTask("notify", f.options)).toEqual(f.task);
});
it("does not turn an ambiguous provider result into delivery or resend", async () => {
  const f = await fixture();
  f.beginDelivery();
  markConversationDeliveryUnknown(f.scope, f.row().notification_id);
  f.start();
  await vi.waitFor(() => expect(f.row().state).toBe("unknown"));
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.append).not.toHaveBeenCalled();
  expect(getSupervisedTask("notify", f.options)?.phase).toBe("ready");
});
it("revokes delivery after source rotation while history append is awaiting", async () => {
  const f = await fixture();
  mocks.append.mockImplementation(async () => {
    mocks.session.mockReturnValue({ entry: { sessionId: "replacement-session" } });
    return { ok: true };
  });
  f.start();
  await vi.waitFor(() => expect(f.row().attempts).toBe(1));
  expect(mocks.send).not.toHaveBeenCalled();
  expect(f.row().state).toBe("pending");
});
it("stopping the service revokes late delivery permission without altering the task", async () => {
  const f = await fixture();
  let release!: () => void;
  mocks.append.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true });
      }),
  );
  f.start();
  await vi.waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(1));
  service!.stop();
  release();
  await vi.waitFor(() => expect(f.row().attempts).toBe(1));
  expect(mocks.send).not.toHaveBeenCalled();
  expect(getSupervisedTask("notify", f.options)).toEqual(f.task);
});
