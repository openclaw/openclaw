import "./dispatch-acp.shared.test-harness.js";
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { tryDispatchAcpReplyHook } from "../../plugin-sdk/acpx.js";
import { createHookRunnerWithRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { persistUserTurnTranscript } from "../../sessions/user-turn-transcript.persistence.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createAcpSourceTranscriptFixture } from "./dispatch-acp.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import {
  createAcpSessionMeta,
  createAcpTestConfig,
  createAcpTestReplyDispatcherFixture as createDispatcher,
} from "./test-fixtures/acp-runtime.js";

const { auditMocks, managerMocks, sessionKey } =
  await import("./dispatch-acp.shared.test-harness.js");

describe("public ACP source receipt original commit", () => {
  it.each(
    (["physical", "revision"] as const).flatMap((change) =>
      [false, true].flatMap((sourceContextAbsent) =>
        [false, true].flatMap((changed) =>
          (["none", "recorder", "runtime"] as const).map((replayed) => ({
            change,
            sourceContextAbsent,
            changed,
            replayed,
          })),
        ),
      ),
    ),
  )(
    "retains the source of previously committed input ($change, absent context: $sourceContextAbsent, changed: $changed, replay mode: $replayed)",
    async ({ change, sourceContextAbsent, changed, replayed }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const runId = `receipt-${change}-${sourceContextAbsent}-${changed}-${replayed}`;
        const prompt = "Retain the source that accepted this input.";
        const fixture = await createAcpSourceTranscriptFixture(state, sessionKey, runId, prompt);
        const { target, entry } = fixture;
        let recorder = fixture.recorder;
        await patchSessionEntryCore(target, () => ({
          lifecycleRevision: "original-commit-revision",
          status: "done",
        }));
        if (change === "revision") {
          const result = await persistUserTurnTranscript({
            ...target,
            sessionEntry: undefined,
            message: await recorder.resolveMessage(),
          });
          if (!result) {
            throw new Error("Missing actual runtime-committed transcript receipt");
          }
          recorder.markRuntimePersisted(result.message, result.admission, {
            appended: result.appended === true,
          });
          if (changed) {
            await patchSessionEntryCore(target, () => ({
              lifecycleRevision: "successor-commit-revision",
            }));
          }
        } else {
          await recorder.persistApproved();
          if (changed) {
            const receipt = recorder.getAdmissionReceipt();
            if (!receipt) {
              throw new Error("Missing actual cached transcript receipt");
            }
            await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
            const originalIdentity = readDatabasePathIdentitySync(receipt.storePath);
            const originalPath = `${receipt.storePath}.original.sqlite`;
            await fs.rename(receipt.storePath, originalPath);
            for (const suffix of ["-wal", "-shm", "-journal"]) {
              try {
                await fs.rename(`${receipt.storePath}${suffix}`, `${originalPath}${suffix}`);
              } catch (error) {
                if (!hasErrnoCode(error, "ENOENT")) {
                  throw error;
                }
              }
            }
            const originalBytes = await fs.readFile(originalPath);
            await fs.copyFile(originalPath, receipt.storePath);
            expect(readDatabasePathIdentitySync(receipt.storePath).key).not.toBe(
              originalIdentity.key,
            );
            expect(await fs.readFile(receipt.storePath)).toEqual(originalBytes);
          }
        }
        if (replayed !== "none") {
          const originalMessage = recorder.getPersistedMessage?.();
          if (!originalMessage?.idempotencyKey) {
            throw new Error("Missing actual original input idempotency key");
          }
          recorder = createUserTurnTranscriptRecorder({
            target: { ...target, sessionEntry: undefined },
            message: originalMessage,
          });
          if (replayed === "runtime") {
            const replay = await persistUserTurnTranscript({
              ...target,
              sessionEntry: undefined,
              message: originalMessage,
            });
            if (!replay) {
              throw new Error("Missing actual runtime replay receipt");
            }
            expect(replay.appended).toBe(false);
            recorder.markRuntimePersisted(replay.message, replay.admission, {
              appended: replay.appended === true,
            });
          }
        }
        const beforeDispatch = loadSessionEntryReadOnly(target);
        managerMocks.resolveSessionAsync.mockResolvedValue({
          kind: "ready",
          sessionKey,
          agentId: target.agentId,
          meta: createAcpSessionMeta(),
          entry,
        });
        const { emitAcpLifecycleEnd } = await vi.importActual<
          typeof import("../../agents/command/acp-lifecycle.js")
        >("../../agents/command/acp-lifecycle.js");
        auditMocks.emitAcpLifecycleEnd.mockImplementationOnce(emitAcpLifecycleEnd);
        managerMocks.runTurn.mockImplementationOnce(
          async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
            await onEvent({ type: "done", status: "completed" });
          },
        );
        const event = {
          ctx: buildTestCtx({
            Provider: "webchat",
            Surface: "webchat",
            SessionKey: sourceContextAbsent ? undefined : sessionKey,
            BodyForAgent: prompt,
          }),
          runId,
          sessionKey,
          inboundAudio: false,
          shouldRouteToOriginating: false,
          shouldSendToolSummaries: true,
          shouldSendFullToolDetails: false,
          sendPolicy: "allow" as const,
        };
        const context = {
          cfg: createAcpTestConfig({ session: { store: target.storePath } }),
          dispatcher: createDispatcher().dispatcher,
          userTurnTranscriptRecorder: recorder,
          recordProcessed: vi.fn(),
          markIdle: vi.fn(),
        };
        const fallback = vi.fn(() => ({
          handled: true,
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        }));
        const { runner } = createHookRunnerWithRegistry([
          {
            hookName: "reply_dispatch",
            pluginId: "acpx",
            handler: () => tryDispatchAcpReplyHook(event, context),
          },
          { hookName: "reply_dispatch", pluginId: "native-fallback", handler: fallback },
        ]);
        expect((await runner.runReplyDispatch(event, context))?.handled).toBe(true);
        expect(fallback).not.toHaveBeenCalled();
        expect(managerMocks.runTurn).toHaveBeenCalledTimes(changed || replayed !== "none" ? 0 : 1);
        expect(
          (await loadTranscriptEvents(target)).filter(
            (value) =>
              isRecord(value) &&
              value.type === "message" &&
              isRecord(value.message) &&
              value.message.role === "user",
          ),
        ).toHaveLength(1);
        if (changed || replayed !== "none") {
          expect(loadSessionEntryReadOnly(target)).toEqual(beforeDispatch);
        } else {
          expect(loadSessionEntryReadOnly(target)).toMatchObject({
            status: "done",
            lastRunId: runId,
          });
        }
      });
    },
  );
});
