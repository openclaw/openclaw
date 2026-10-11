import { expect, it, vi } from "vitest";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { installDurableQuestion } from "./durable-question-runtime.js";
import { QuestionManager } from "./question-manager.js";

function question(): DurableQuestion {
  return {
    record: {
      id: "same",
      agentId: "main",
      sessionKey: "agent:main:test",
      createdAtMs: 1,
      expiresAtMs: 1000,
      status: "pending",
      questions: [],
    },
    sessionKey: "agent:main:test",
    sessionId: "session",
    lifecycleRevision: "revision",
    sessionBinding: {
      agentId: "main",
      sessionKey: "agent:main:test",
      storePath: "/tmp/test.db",
      databasePath: "/tmp/test.db",
      databaseIdentity: { identity: "test" },
      sessionId: "session",
      lifecycleRevision: "revision",
    },
    provenance: {
      issuer: "channel",
      sourceRunId: "source",
      channelAuthorizationReference: { version: 1, id: "linked" },
    },
    continuation: { status: "pending" },
  };
}

it("reinstalls only identical canonical custody and never silently adopts an existing transient or foreign observation", async () => {
  const manager = new QuestionManager(createTestGatewayScheduler());
  const original = question();
  const owed = vi.fn();
  installDurableQuestion(manager, original, owed);
  const observation = manager.observe("same");
  installDurableQuestion(manager, structuredClone(original), owed);
  expect(manager.observe("same")?.record).toBe(observation?.record);
  expect(() =>
    installDurableQuestion(
      manager,
      { ...original, provenance: { ...original.provenance, sourceRunId: "foreign" } },
      owed,
    ),
  ).toThrow("already exists");
  expect(() =>
    installDurableQuestion(
      manager,
      {
        ...original,
        sessionBinding: {
          ...original.sessionBinding,
          databaseIdentity: { identity: "replacement" },
        },
      },
      owed,
    ),
  ).toThrow("already exists");
  expect(() =>
    installDurableQuestion(
      manager,
      {
        ...original,
        record: {
          ...original.record,
          createdAtMs: original.record.createdAtMs + 1,
          expiresAtMs: original.record.expiresAtMs + 1,
        },
      },
      owed,
    ),
  ).toThrow("already exists");
  manager.reset();
  manager.request({ id: "same", questions: [], timeoutMs: 1000 });
  expect(() => installDurableQuestion(manager, original, owed)).toThrow("already exists");
  expect(manager.hasDurableCustody("same")).toBe(false);
  manager.close();
  await manager.drain();
});
