import fs from "node:fs";
import { copyFile, rename } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/io.js";
import { prepareQualifiedSessionEntryTarget } from "../../config/sessions/session-accessor.entry.js";
import { resolveSessionTranscriptDatabasePath } from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as transcriptAnchors from "../../config/sessions/session-transcript-anchor-read.js";
import * as historyReaders from "../../config/sessions/session-transcript-worker-readers.js";
import { targetDiscoveryLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
} from "../../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { createReplyTranscriptFixture } from "./chat-send-reply-dispatch.test-support.js";
import { createChatReplySessionReader } from "./chat-send-reply-session.js";
import { createChatSendWorkAdmission } from "./chat-send-work-admission.js";

function observeTargetRequests(onKind: (kind: unknown) => void | Promise<void>) {
  const run = targetDiscoveryLane.pool.run.bind(targetDiscoveryLane.pool);
  return vi.spyOn(targetDiscoveryLane.pool, "run").mockImplementation(async (...args) => {
    const reply = await run(...args);
    if (
      reply.ok &&
      typeof reply.value === "object" &&
      reply.value !== null &&
      "kind" in reply.value
    ) {
      const pending = onKind(reply.value.kind);
      if (pending) {
        await pending;
      }
    }
    return reply;
  });
}

it("selects display payloads and delivery anchors in one transcript request", async () => {
  await withOpenClawTestState({ label: "chat-delivery-one-snapshot" }, async () => {
    const { dispatch, append } = await createReplyTranscriptFixture();
    dispatch.captureAgentTranscriptStart();
    await append("answer", { role: "assistant", content: "Committed answer." });
    const requests: string[] = [];
    const createReaders = historyReaders.createSessionHistoryWorkerReaders;
    using _ = vi
      .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
      .mockImplementation((runRequest) =>
        createReaders((prepare, ...args) =>
          runRequest(
            () => {
              const input = prepare();
              requests.push(input.kind);
              return input;
            },
            ...args,
          ),
        ),
      );
    const deliveryRequests = () =>
      requests.filter((kind) =>
        ["transcript-anchors", "transcript-watermark", "history-page"].includes(kind),
      );
    expect(await dispatch.resolveReplyDeliveryFacts()).toEqual({
      source: "missing",
      terminal: "delivered",
    });
    expect(requests.filter((kind) => kind === "transcript-anchors")).toHaveLength(1);
    requests.length = 0;
    expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
    expect(deliveryRequests()).toEqual(["transcript-anchors"]);
    await append("source-answer", {
      role: "assistant",
      content: "Committed source answer.",
      openclawDeliveryMirror: { kind: "message-tool-source-reply", final: true },
    });
    requests.length = 0;
    expect(await dispatch.resolveReplyDeliveryFacts()).toEqual({
      source: "delivered",
      terminal: "delivered",
    });
    expect(deliveryRequests()).toEqual(["transcript-anchors"]);
  });
});

it.each(["release", "replacement"] as const)(
  "rereads a borrowed reply source and refuses %s without rediscovery",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const scope = { agentId: "main", sessionKey: "agent:main:reply-source" };
      replaceSessionEntrySync(scope, { sessionId: "reply-session", updatedAt: 1 });
      const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: {},
        key: scope.sessionKey,
        agentId: scope.agentId,
      });
      const qualified = await prepareQualifiedSessionEntryTarget(
        {
          ...loaded,
          requestedKey: scope.sessionKey,
          storeKey: loaded.canonicalKey,
          readSource: loaded.capturedReadSource,
        },
        loaded.capturedReadSources,
      );
      const work = createChatSendWorkAdmission({
        admission: { release: vi.fn() },
        releaseCallerAuthority: vi.fn(),
        logGateway: { warn: vi.fn() },
      });
      const reader = createChatReplySessionReader(
        {
          ...loaded,
          ...scope,
          cfg: {},
          clientRunId: "reply-run",
          backingSessionId: "reply-session",
          sessionLoadOptions: { agentId: scope.agentId },
          sessionTarget: qualified,
        },
        getRuntimeConfig,
        () => {
          if (!work.isActive()) {
            throw new Error("reply work ended");
          }
        },
      );
      const reading = createDeferred();
      const resume = createDeferred();
      let hold = false;
      let inventories = 0;
      const spy = observeTargetRequests((kind) => {
        if (kind === "session-target-inventory") {
          inventories += 1;
        }
        if (hold && kind === "session-exact-entries") {
          reading.resolve();
          return resume.promise;
        }
        return undefined;
      });
      try {
        for (const updatedAt of [2, 3]) {
          replaceSessionEntrySync(scope, { sessionId: "reply-session", updatedAt });
          const host = observeHostDataSql();
          try {
            expect((await reader.readCurrentSession()).entry?.updatedAt).toBe(updatedAt);
            expect(host.queries).toEqual([]);
          } finally {
            host.restore();
          }
        }
        if (boundary === "replacement") {
          const pathname = loaded.capturedReadSource!.path;
          await closeOpenClawAgentDatabasesAsync();
          fs.copyFileSync(pathname, `${pathname}.replacement`);
          fs.renameSync(`${pathname}.replacement`, pathname);
          await expect(reader.readCurrentSession()).rejects.toThrow();
          expect(inventories).toBe(0);
          return;
        }
        hold = true;
        sessionChanges.invalidate({
          ...scope,
          storePath: loaded.capturedReadSource!.path,
          factsInvalidated: true,
        });
        const pending = reader.readCurrentSession();
        void pending.catch(() => {});
        await awaitGateBeforeSettlement(
          reading.promise,
          pending,
          "reply read did not reach the worker",
        );
        work.release();
        resume.resolve();
        await expect(pending).rejects.toThrow("reply work ended");
        expect(inventories).toBe(0);
      } finally {
        resume.resolve();
        work.release();
        spy.mockRestore();
      }
    });
  },
);

it.each(["unchanged", "foreign-lifecycle", "physical-replacement"] as const)(
  "uses one entry phase and rechecks %s before the terminal delivery snapshot",
  async (change) => {
    await withOpenClawTestState({ label: "webchat-retained-terminal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const { dispatch, append, scope, runId, release } = await createReplyTranscriptFixture(
        "agent:main:retained-terminal",
        true,
      );
      try {
        await dispatch.runAgentMediaTranscript(
          { run: async (operation) => operation() },
          async () => {
            dispatch.captureAgentTranscriptStart();
            await append("answer", { role: "assistant", content: "Committed answer." });
            const readAnchors = transcriptAnchors.readSessionTranscriptAnchorsAsync;
            using snapshotRead = vi
              .spyOn(transcriptAnchors, "readSessionTranscriptAnchorsAsync")
              .mockImplementationOnce(async (...args) => {
                expect(args[1]).toMatchObject({
                  includeSession: true,
                  includeMessagesForRunId: runId,
                });
                const databasePath = resolveSessionTranscriptDatabasePath(scope);
                if (change === "foreign-lifecycle") {
                  using foreign = new DatabaseSync(databasePath);
                  foreign
                    .prepare(
                      "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lifecycleRevision', ?) WHERE session_key = ?",
                    )
                    .run("foreign-successor", scope.sessionKey);
                } else if (change === "physical-replacement") {
                  await closeOpenClawAgentDatabaseByPathAsync(databasePath, scope.agentId);
                  const replacement = state.path("terminal-replacement.sqlite");
                  await copyFile(databasePath, replacement);
                  await rename(replacement, databasePath);
                }
                const facts = await readAnchors(...args);
                expect(facts.tail?.entries).toContainEqual(
                  expect.objectContaining({
                    entryId: "answer",
                    message: expect.objectContaining({ role: "assistant" }),
                  }),
                );
                return facts;
              });
            let entries = 0;
            using _ = observeTargetRequests((kind) => {
              if (kind === "session-exact-entries") {
                entries++;
              }
            });
            const result = dispatch.resolveReplyDelivery();
            if (change === "physical-replacement") {
              await expect(result).rejects.toThrow();
            } else {
              expect(await result).toBe(change === "unchanged" ? "delivered" : "missing");
            }
            expect(snapshotRead).toHaveBeenCalled();
            expect(entries).toBe(1);
          },
        );
      } finally {
        release();
      }
    });
  },
);
