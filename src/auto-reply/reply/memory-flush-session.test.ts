import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEventsSync,
  readActiveTranscriptEntryAnchor,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "../../config/sessions/session-accessor.sqlite-visible-cursor.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { createSessionTranscriptHeader } from "../../config/sessions/transcript-header.js";
import { readPendingUserTurnTranscriptAdmission } from "../../sessions/user-turn-transcript-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { ensureMemoryFlushTargetFile, prepareMemoryFlushSession } from "./memory-flush-session.js";

const assistant = (text: string) =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });
async function createScope(state: OpenClawTestState, sessionId: string) {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  return scope;
}
async function admit(scope: Awaited<ReturnType<typeof createScope>>) {
  const recorder = createUserTurnTranscriptRecorder({
    input: {
      text: "Unprocessed current question: do not checkpoint this yet.",
      idempotencyKey: "foreground:user",
    },
    target: { ...scope, expectedSessionId: scope.sessionId, sessionEntry: undefined },
  });
  await recorder.persistApproved();
  const admission = readPendingUserTurnTranscriptAdmission(recorder);
  if (!admission) {
    throw new Error("Fixture failed to admit its current user");
  }
  return admission;
}

it.each(["mkdir", "open"] as const)(
  "settles memory target preparation after operator revocation during %s",
  async (boundary) =>
    withOpenClawTestState({ label: "memory-target-authority" }, async (state) => {
      const targetPath = path.join(state.workspaceDir, "memory", "checkpoint.md");
      const originalMkdir = fs.mkdir.bind(fs);
      const originalOpen = fs.open.bind(fs);
      const refusal = new Error("memory target authority revoked");
      let operatorCurrent = true;
      const operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "guest",
        scopes: ["operator.write"],
        assertCurrent: () => {
          if (!operatorCurrent) {
            throw refusal;
          }
        },
      });
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      let closes = 0;
      let restoreClose: (() => void) | undefined;
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementationOnce(async (directory, options) => {
        const created = await originalMkdir(directory, options);
        operatorCurrent = boundary !== "mkdir";
        return created;
      });
      const openSpy = vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
        handle = await originalOpen(file, flags, mode);
        const close = handle.close.bind(handle);
        const closeSpy = vi.spyOn(handle, "close").mockImplementation(async () => {
          closes += 1;
          await close();
        });
        restoreClose = () => closeSpy.mockRestore();
        operatorCurrent = boundary !== "open";
        return handle;
      });
      try {
        await expect(
          ensureMemoryFlushTargetFile({
            workspaceDir: state.workspaceDir,
            relativePath: "memory/checkpoint.md",
            assertCurrent: () => operatorAuthority.assertCurrent(),
          }),
        ).rejects.toBe(refusal);
        expect(openSpy).toHaveBeenCalledTimes(boundary === "open" ? 1 : 0);
        expect(closes).toBe(boundary === "open" ? 1 : 0);
        if (boundary === "open") {
          await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("");
        } else {
          await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        mkdirSpy.mockRestore();
        openSpy.mockRestore();
        try {
          if (handle && closes === 0) {
            await handle.close();
          }
        } finally {
          restoreClose?.();
        }
      }
    }),
);

it("isolates a required checkpoint while preserving compacted admitted input", async () =>
  withOpenClawTestState({ label: "memory-checkpoint" }, async (state) => {
    const { workspaceDir } = state;
    setRuntimeConfigSnapshot({});
    onTestFinished(() => clearRuntimeConfigSnapshot());
    const scope = await createScope(state, "foreground-session");
    const source = SessionManager.open(scope, state.workspaceDir);
    source.appendMessage({ role: "user", content: "Earlier topic", timestamp: 1 });
    source.appendMessage(assistant("Earlier reply"));
    const retained = source.appendMessage(makeUserMessage("Keep the Cedar project receipt.", 3));
    source.appendMessage(assistant("Cedar receipt is maple-17."));
    source.appendCompaction("Earlier conversation summary", retained, 500);
    source.appendMessage({
      role: "user",
      content: "Excluded diagnostic payload",
      timestamp: 4,
      excludeFromContext: true,
    });
    source.appendCustomEntry("openclaw:bootstrap-context:full", { revision: "fixture" });
    await waitForSessionTranscriptProjection(scope);
    const priorContext = source.buildSessionContext();
    const admission = await admit(scope);
    const before = loadTranscriptEventsSync(scope);
    const anchor = readActiveTranscriptEntryAnchor(admission);
    const checkpoint = await prepareMemoryFlushSession({
      admission,
      source: {
        ...scope,
        expectedWriterRunId: "foreground-writer",
        threadId: "foreground-native-thread",
      },
      runId: "memory-helper",
      workspaceDir,
    });
    const manager = checkpoint.sessionManager;
    expect(manager.getSessionTarget()).toBeUndefined();
    expect(manager.buildSessionContext().messages).toEqual(priorContext.messages);
    expect(checkpoint.sessionId).not.toBe(scope.sessionId);
    expect(checkpoint.sessionKey).not.toBe(scope.sessionKey);
    expect(checkpoint.sessionTarget).not.toHaveProperty("expectedWriterRunId");
    expect(checkpoint.sessionTarget).not.toHaveProperty("threadId");
    expect(checkpoint.sessionPersistence).toBe("detached");
    const first = manager.getBranch()[0];
    if (first) {
      if (first.type === "message" && first.message.role === "user") {
        first.message.content = "Checkpoint-only edit";
      }
      manager.branch(first.id);
    }
    const instruction = manager.appendMessage(makeUserMessage("Checkpoint instruction", 5));
    manager.appendMessage(assistant("NO_REPLY"));
    manager.appendCompaction("Checkpoint-only summary", instruction, 100);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    expect(readActiveTranscriptEntryAnchor(admission)).toEqual(anchor);
    expect(SessionManager.open(scope).getBranch().at(-1)?.id).toBe(admission.entryId);
  }));

it.each(["empty", "cancelled", "bounded"] as const)(
  "preserves the source transcript during %s checkpoint acquisition",
  async (mode) =>
    withOpenClawTestState({ label: "memory-checkpoint" }, async (state) => {
      setRuntimeConfigSnapshot({});
      onTestFinished(() => clearRuntimeConfigSnapshot());
      const scope = await createScope(state, `${mode}-checkpoint`);
      const seed = SessionManager.fromEntries([
        createSessionTranscriptHeader({ cwd: state.workspaceDir, sessionId: scope.sessionId }),
      ]);
      for (let i = 0; i <= (mode === "bounded" ? MAX_VISIBLE_MESSAGE_MAX_MESSAGES : 0); i += 1) {
        seed.appendMessage({ role: "user", content: `Prior record ${i}`, timestamp: i });
      }
      if (mode !== "empty") {
        await replaceTranscriptEvents(scope, [seed.getHeader(), ...seed.getEntries()]);
      }
      const admission = mode === "empty" ? undefined : await admit(scope);
      const before = loadTranscriptEventsSync(scope);
      const reason = new Error("cancel required checkpoint");
      const result = prepareMemoryFlushSession({
        admission,
        source: scope,
        runId: "checkpoint-helper",
        workspaceDir: state.workspaceDir,
        signal: mode === "cancelled" ? AbortSignal.abort(reason) : undefined,
      });
      if (mode === "empty") {
        const { sessionManager } = await result;
        expect(sessionManager.getSessionTarget()).toBeUndefined();
        expect(sessionManager.getHeader()).toMatchObject({ id: scope.sessionId });
        expect(sessionManager.buildSessionContext().messages).toEqual([]);
      } else if (mode === "cancelled") {
        await expect(result).rejects.toBe(reason);
      } else {
        await expect(result).rejects.toThrow("bounded conversation view");
      }
      expect(loadTranscriptEventsSync(scope)).toEqual(before);
    }),
);
