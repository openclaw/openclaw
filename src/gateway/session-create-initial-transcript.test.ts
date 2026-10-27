import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { buildAssistantMessage, buildUsageWithNoCost } from "../agents/stream-message-shared.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

const message = buildAssistantMessage({
  model: { api: "openclaw-transcript", provider: "openclaw", id: "onboarding" },
  content: [{ type: "text", text: "Hi! What would you like to call me?" }],
  stopReason: "stop",
  usage: buildUsageWithNoCost({ input: 0, output: 0 }),
  timestamp: 123,
});
const initialAssistantMessage = { message, idempotencyKey: "opening" };
type CreateParams = Parameters<typeof createGatewaySession>[0];
const create = (
  params: Omit<CreateParams, "cfg" | "commandSource" | "operatorRoleActor"> & {
    cfg?: CreateParams["cfg"];
  },
) =>
  createGatewaySession({
    cfg: {},
    commandSource: "test",
    operatorRoleActor: { kind: "system" },
    ...params,
  });

it("commits the initial assistant with the new session before publication and preserves an existing transcript", async () => {
  await withOpenClawTestState({ label: "session-initial-assistant" }, async () => {
    const key = "agent:main:initial-assistant";
    let publishedTranscript: ReturnType<typeof loadTranscriptEvents> | undefined;
    const created = await create({
      key,
      initialAssistantMessage,
      onCreatedSessionCommitted(session) {
        expect(session.entry.initializationPending).toBeUndefined();
        publishedTranscript = loadTranscriptEvents({
          agentId: session.agentId,
          sessionKey: session.key,
          sessionId: session.entry.sessionId,
          storePath: session.storePath,
        });
      },
    });
    expect(created).toMatchObject({ ok: true, postCommit: { status: "completed" } });
    assert(created.ok);
    const events = await publishedTranscript;
    expect(events).toEqual([
      expect.objectContaining({ type: "session", id: created.entry.sessionId }),
      expect.objectContaining({
        type: "message",
        parentId: null,
        message: { ...message, idempotencyKey: "opening" },
      }),
    ]);
    const collision = await create({
      key,
      initialAssistantMessage: {
        message: {
          ...message,
          content: [{ type: "text", text: "Must not replace the conversation" }],
        },
      },
    });
    expect(collision).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("requires a new session") },
    });
    expect(
      await loadTranscriptEvents({ sessionKey: key, sessionId: created.entry.sessionId }),
    ).toEqual(events);
  });
});

it("rechecks current authority after preparing the initial transcript and commits neither row nor greeting on refusal", async () => {
  await withOpenClawTestState({ label: "session-initial-assistant-authority" }, async () => {
    const key = "agent:main:initial-assistant-revoked";
    let current = true;
    const published = vi.fn();
    await expect(
      create({
        key,
        initialAssistantMessage,
        onPhase(phase) {
          if (phase === "writerAdmission" || phase === "commit") {
            current = false;
          }
        },
        commitGuard() {
          if (!current) {
            throw new Error("creation authority revoked");
          }
        },
        onCreatedSessionCommitted: published,
      }),
    ).rejects.toThrow("creation authority revoked");
    expect(published).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly({ sessionKey: key })).toBeUndefined();
  });
});

it("creates a seeded child instead of taking the legacy main-session reset shortcut", async () => {
  await withOpenClawTestState({ label: "session-initial-assistant-no-reset" }, async () => {
    const cfg = { session: { dmScope: "main" as const } };
    const parent = await create({ cfg, key: "agent:main:main" });
    assert(parent.ok);
    const child = await create({
      cfg,
      parentSessionKey: parent.key,
      emitCommandHooks: true,
      resetMainWhenUnspecified: true,
      initialAssistantMessage,
    });
    expect(child).toMatchObject({ ok: true, resetExisting: false });
    assert(child.ok);
    expect(child.key).not.toBe(parent.key);
    expect(loadSessionEntryReadOnly({ sessionKey: parent.key })?.sessionId).toBe(
      parent.entry.sessionId,
    );
    const events = await loadTranscriptEvents({
      sessionKey: child.key,
      sessionId: child.entry.sessionId,
    });
    expect(events.filter((event) => isRecord(event) && event.type === "message")).toEqual([
      expect.objectContaining({ message: { ...message, idempotencyKey: "opening" } }),
    ]);
  });
});
