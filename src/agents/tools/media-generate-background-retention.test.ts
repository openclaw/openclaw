import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import * as entryReader from "../../config/sessions/session-entry-read-runtime.js";
import * as transcript from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as managedMedia from "../../gateway/managed-image-attachments.js";
import { artifactsHandlers } from "../../gateway/server-methods/artifacts.js";
import { chatHistoryHandlers } from "../../gateway/server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "../../gateway/server-methods/chat-history.test-helpers.js";
import type { GatewayClient } from "../../gateway/server-methods/types.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as sessionDelivery from "../../infra/session-delivery-queue-storage.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import {
  hasPendingGeneratedMediaTaskForSessionKey as hasPending,
  listMediaGenerationOperations,
} from "../media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import { findDuplicateGuardImageGenerationTaskForSession as findDuplicate } from "../media-generation-task-status.js";
import * as announceDelivery from "../subagents/announce/subagent-announce-delivery.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { retainBlockedMediaCompletion } from "./media-generate-background-completion.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";
import {
  imageGenerationTaskLifecycle,
  runMediaGenerationTask,
} from "./media-generate-background.js";
import { buildMediaGenerateToolExecutionResult as buildResult } from "./media-generate-result-shared.js";

const sessionKey = "agent:main:media";
const sessionId = "original";
const generated = { provider: "synthetic", model: "fixture", count: 1, wakeResult: "generated" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGeneratedMediaTaskActivityForTests();
});

async function configure(state: OpenClawTestState, config: OpenClawConfig) {
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
}

async function requester(
  state: OpenClawTestState,
  key = sessionKey,
  id = sessionId,
  revision: string | null = "original",
  mediaMaxMb?: number,
) {
  const scope = {
    agentId: "main",
    sessionKey: key,
    storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
  };
  const entry = { sessionId: id, lifecycleRevision: revision ?? undefined, updatedAt: 1 };
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      ...(mediaMaxMb ? { defaults: { mediaMaxMb } } : {}),
      entries: { main: { workspace: state.workspaceDir } },
    },
  };
  await configure(state, config);
  await replaceSessionEntry(scope, entry);
  return { scope, entry, config };
}

function scheduleCompletion(
  params: Pick<
    Parameters<typeof scheduleMediaGenerationTaskCompletion>[0],
    "lifecycle" | "handle" | "run"
  >,
) {
  const scheduled: Array<() => Promise<void>> = [];
  scheduleMediaGenerationTaskCompletion({
    ...params,
    scheduleBackgroundWork: (work) => scheduled.push(work),
    progressSummary: "Generating image",
    toolName: "image_generate",
    onWakeFailure: vi.fn(),
  });
  expect(scheduled).toHaveLength(1);
  return scheduled[0]!;
}

function deleteRequester(scope: Awaited<ReturnType<typeof requester>>["scope"]) {
  return deleteSessionEntryLifecycle({
    ...scope,
    archiveTranscript: false,
    target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
  });
}

function successfulDelivery() {
  return vi.spyOn(announceDelivery, "deliverSubagentAnnouncement").mockResolvedValue({
    delivered: true,
    path: "direct",
  });
}

function runTask(
  params: Pick<
    Parameters<typeof runMediaGenerationTask>[0],
    "run" | "scheduleBackgroundWork" | "resources"
  >,
) {
  return runMediaGenerationTask({
    lifecycle: imageGenerationTaskLifecycle,
    sessionKey,
    generationLabel: "image",
    requesterAgentId: "main",
    prompt: "synthetic lighthouse",
    requestKey: "synthetic-request",
    onFailure: vi.fn(),
    ...params,
  });
}

async function invokeHistoryMethod(
  method: "chat.history" | "artifacts.download",
  params: Record<string, unknown>,
  client: GatewayClient | null = null,
) {
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  const context = await createHistoryReadContext();
  const handler =
    method === "chat.history" ? chatHistoryHandlers[method] : artifactsHandlers[method];
  assert(handler, `${method} handler is unavailable`);
  await handler({
    params,
    context,
    req: { type: "req", id: "retained-media", method },
    client,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
  });
  assert(result, `${method} did not respond`);
  return result;
}

it("keeps a prepared image when another blocked-completion image exceeds the limit", async () => {
  await withOpenClawTestState({ prefix: "media-blocked-partial-image-" }, async (state) => {
    const { scope } = await requester(state, sessionKey, sessionId, "original", 20);
    const imageBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
    const imagePath = state.statePath("media", "retained.png");
    const oversizedPath = state.statePath("media", "too-large.png");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, Buffer.from(imageBase64, "base64"));
    await fs.writeFile(oversizedPath, Buffer.alloc(12 * 1024 * 1024 + 1));
    const lifecycle = createMediaGenerationTaskLifecycle("image");
    const handle = await lifecycle.createTaskRun({
      sessionKey: scope.sessionKey,
      requesterAgentId: "main",
      prompt: "two synthetic images",
    });
    assert(handle, "Expected an active media-generation handle");

    await retainBlockedMediaCompletion({
      handle,
      terminalResult: { terminalOutcome: "blocked" },
      attachments: [
        { type: "image", path: imagePath, mimeType: "image/png" },
        { type: "image", path: oversizedPath, mimeType: "image/png" },
      ],
    });

    const history = await invokeHistoryMethod("chat.history", { sessionKey: scope.sessionKey });
    expect(history.ok).toBe(true);
    const messages = (history.payload as { messages?: unknown[] }).messages ?? [];
    const retained = messages.find((message) => isRecord(message) && message.role === "assistant");
    const content = isRecord(retained) && Array.isArray(retained.content) ? retained.content : [];
    expect(content.filter((block) => isRecord(block) && block.type === "image")).toHaveLength(1);
  });
});

it("reconciles image ownership when a blocked-completion retry finds its message", async () => {
  await withOpenClawTestState({ prefix: "media-blocked-reconcile-" }, async (state) => {
    const { scope } = await requester(state);
    const imageBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
    const imagePath = state.statePath("media", "generated.png");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, Buffer.from(imageBase64, "base64"));
    const lifecycle = createMediaGenerationTaskLifecycle("image");
    const handle = await lifecycle.createTaskRun({
      sessionKey: scope.sessionKey,
      requesterAgentId: "main",
      prompt: "synthetic lighthouse",
    });
    assert(handle, "Expected an active media-generation handle");
    const attach = vi.spyOn(managedMedia, "attachManagedOutgoingMediaToMessage");
    attach.mockImplementationOnce(async () => false);

    const params = {
      handle,
      terminalResult: { terminalOutcome: "blocked" as const },
      attachments: [{ type: "image" as const, path: imagePath, mimeType: "image/png" }],
    };
    await expect(retainBlockedMediaCompletion(params)).rejects.toThrow(
      "Could not persist retained generated image ownership",
    );
    await retainBlockedMediaCompletion(params);

    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach.mock.calls[1]?.[0].messageId).toBe(attach.mock.calls[0]?.[0].messageId);
    const history = await invokeHistoryMethod("chat.history", { sessionKey: scope.sessionKey });
    expect(history.ok).toBe(true);
    const messages = (history.payload as { messages?: unknown[] }).messages ?? [];
    expect(
      messages.filter(
        (message) =>
          isRecord(message) &&
          message.role === "assistant" &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              isRecord(block) &&
              block.type === "text" &&
              typeof block.text === "string" &&
              block.text.includes("Generated media is ready"),
          ),
      ),
    ).toHaveLength(1);
    const retained = messages.find((message) => isRecord(message) && message.role === "assistant");
    const content = isRecord(retained) && Array.isArray(retained.content) ? retained.content : [];
    expect(content.filter((block) => isRecord(block) && block.type === "image")).toHaveLength(1);
  });
});

it("keeps a blocked text-only completion free of managed image blocks", async () => {
  await withOpenClawTestState({ prefix: "media-blocked-text-" }, async (state) => {
    const { scope } = await requester(state);
    const lifecycle = createMediaGenerationTaskLifecycle("image");
    const handle = await lifecycle.createTaskRun({
      sessionKey: scope.sessionKey,
      requesterAgentId: "main",
      prompt: "synthetic lighthouse without an attachment",
    });
    assert(handle, "Expected an active media-generation handle");
    await retainBlockedMediaCompletion({
      handle,
      terminalResult: { terminalOutcome: "blocked" },
    });

    const history = await invokeHistoryMethod("chat.history", { sessionKey: scope.sessionKey });
    expect(history.ok).toBe(true);
    const messages = (history.payload as { messages?: unknown[] }).messages ?? [];
    const retained = messages.find((message) => isRecord(message) && message.role === "assistant");
    expect(retained).toMatchObject({
      content: [
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Generated media is ready"),
        }),
      ],
    });
  });
});

it.each([
  "current",
  "replaced",
  "rotated",
  "deleted",
  "retired-during-append",
  "retired-at-commit",
] as const)("retains references in the live requester: %s", async (requesterState) => {
  await withOpenClawTestState({ prefix: "media-retention-" }, async (state) => {
    const { scope } = await requester(state);
    vi.useFakeTimers({ toFake: ["Date"] });
    const realPerformanceNow = performance.now.bind(performance);
    let performanceClockSkewMs = 0;
    const enqueue = vi
      .spyOn(sessionDelivery, "enqueueClaimedSessionDelivery")
      .mockImplementation(async () => {
        performanceClockSkewMs += 120_001;
        throw new Error("synthetic queue admission refused");
      });
    const append = transcript.appendAssistantMessageToSessionTranscript;
    const appendSpy = vi.spyOn(transcript, "appendAssistantMessageToSessionTranscript");
    let retaining = false;
    let revokedAtCommit = false;
    if (requesterState === "retired-at-commit") {
      appendSpy.mockImplementationOnce(async (params) => {
        retaining = true;
        try {
          return await append(params);
        } finally {
          retaining = false;
        }
      });
      probe.admission(admission, (request, grant, callback) => {
        if (retaining && request.stage === "commit") {
          revokedAtCommit = true;
          rotateAgentEventLifecycleGeneration();
        }
        callback(request, grant);
      });
    }
    if (requesterState === "retired-during-append") {
      appendSpy.mockImplementationOnce(async (params) => {
        await Promise.resolve();
        rotateAgentEventLifecycleGeneration();
        return append(params);
      });
    }
    const lifecycle = createMediaGenerationTaskLifecycle("image");
    if (requesterState === "current") {
      await cleanupSessionStateForTest({ stateDir: state.stateDir });
    }
    vi.spyOn(performance, "now").mockImplementation(
      () => realPerformanceNow() + performanceClockSkewMs,
    );
    const creationSql = requesterState === "current" ? observeMainThreadSql() : undefined;
    let handle;
    try {
      handle = await lifecycle.createTaskRun({
        sessionKey,
        requesterAgentId: "main",
        prompt: "a synthetic lighthouse",
        requesterOrigin: { channel: "webchat" },
      });
      creationSql?.expectIdle();
    } finally {
      creationSql?.restore();
    }
    assert(handle);
    const mediaPath = state.statePath("media", "synthetic-lighthouse.png");
    const complete = scheduleCompletion({
      lifecycle,
      handle,
      run: async () => {
        if (requesterState === "replaced" || requesterState === "rotated") {
          await replaceSessionEntry(scope, {
            sessionId: requesterState === "replaced" ? "replacement-requester" : sessionId,
            lifecycleRevision: "replacement-lifecycle",
            updatedAt: Date.now(),
          });
        } else if (requesterState === "deleted") {
          await deleteRequester(scope);
        }
        return {
          ...generated,
          attachments: [{ type: "image" as const, path: mediaPath, mimeType: "image/png" }],
        };
      },
    });
    await complete();
    expect(hasPending(sessionKey, "main")).toBe(false);
    const admitsDelivery = requesterState === "current" || requesterState.startsWith("retired-");
    expect(enqueue).toHaveBeenCalledTimes(admitsDelivery ? 1 : 0);
    expect(appendSpy).toHaveBeenCalledOnce();
    if (requesterState === "retired-at-commit") {
      expect(revokedAtCommit).toBe(true);
    }
    if (requesterState === "current") {
      await complete();
    }
    vi.restoreAllMocks();
    resetGeneratedMediaTaskActivityForTests();
    await cleanupSessionStateForTest({ stateDir: state.stateDir });
    const events = await loadTranscriptEvents({ ...scope, sessionId });
    if (requesterState === "current") {
      const messages = events.filter((event) => isRecord(event) && event.type === "message");
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages)).toContain(mediaPath);
      expect(JSON.stringify(messages)).toContain("delivery");
    } else {
      expect(events).toEqual([]);
      if (requesterState === "replaced") {
        expect(
          await loadTranscriptEvents({ ...scope, sessionId: "replacement-requester" }),
        ).toEqual([]);
      }
    }
  });
});
it("preserves peer ownership through the durable transcript", async () => {
  await withOpenClawTestState({ prefix: "media-shared-main-" }, async (state) => {
    const runKey = "agent:main:main";
    const firstKey = "agent:main:discord:default:direct:peer-a";
    const secondKey = "agent:main:discord:default:direct:peer-b";
    await requester(state, runKey, sessionId);
    const prompt = "a synthetic lighthouse";
    const firstOrigin = { channel: "discord", accountId: "default", to: "user:peer-a" };
    const lifecycle = imageGenerationTaskLifecycle;
    const create = (key: string, requesterOrigin = firstOrigin) =>
      lifecycle.createTaskRun({
        sessionKey: key,
        requesterRunSessionKey: runKey,
        requesterAgentId: "main",
        requesterOrigin,
        prompt,
      });
    const duplicate = (key: string) => findDuplicate(key, { prompt, agentId: "main" });
    const first = await create(firstKey);
    expect(first).toMatchObject({
      detach: true,
      requesterSessionKey: firstKey,
      requesterOrigin: firstOrigin,
      requesterTranscript: {
        sessionKey: runKey,
        sessionId,
        lifecycleRevision: "original",
      },
    });
    expect(await duplicate(firstKey)).toMatchObject({
      taskId: first?.taskId,
      requesterSessionKey: firstKey,
    });
    expect(await duplicate(secondKey)).toBeUndefined();
    const second = await create(secondKey, { ...firstOrigin, to: "user:peer-b" });
    expect(second).toMatchObject({ detach: true, requesterSessionKey: secondKey });
    expect(second?.taskId).not.toBe(first?.taskId);
    for (const [key, handle] of [
      [firstKey, first],
      [secondKey, second],
    ] as const) {
      expect(await duplicate(key)).toMatchObject({
        taskId: handle?.taskId,
        requesterSessionKey: key,
      });
    }
    const deliver = successfulDelivery();
    await expect(
      lifecycle.wakeTaskCompletion({
        handle: first,
        status: "ok",
        statusLabel: "completed successfully",
        result: "generated",
      }),
    ).resolves.toEqual({ status: "delivered" });
    expect(deliver.mock.lastCall?.[0]).toMatchObject({
      requesterSessionKey: firstKey,
      targetRequesterSessionKey: runKey,
      preparedRequester: { binding: { sessionKey: runKey, sessionId } },
      requesterSessionOrigin: firstOrigin,
      completionDirectOrigin: firstOrigin,
      directOrigin: firstOrigin,
    });
  });
});

it("tracks a missing requester inline", async () => {
  await withOpenClawTestState({ prefix: "media-missing-requester-" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
    await configure(state, cfg);
    const schedule = vi.fn();
    const run = vi.fn(async (handle) => {
      expect(handle).toMatchObject({ detach: false, requesterTranscript: undefined });
      expect(hasPending(sessionKey, "main")).toBe(true);
      return { ...generated, contentText: "inline result", details: { generated: true } };
    });
    const result = await runTask({ scheduleBackgroundWork: schedule, run });
    expect(run).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
    expect(result).toMatchObject({ content: [{ type: "text", text: "inline result" }] });
    expect(hasPending(sessionKey, "main")).toBe(false);
    expect(listMediaGenerationOperations(sessionKey, "main")).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ]);
  });
});

it.each([
  ["lookup", "invocation"],
  ["lookup", "cancellation"],
  ["lookup", "generation"],
  ["admission", "invocation"],
  ["admission", "cancellation"],
  ["admission", "generation"],
] as const)("refuses provider work after %s %s revocation", async (phase, revocation) => {
  await withOpenClawTestState({ prefix: "media-admission-" }, async (state) => {
    await requester(state, sessionKey, sessionId, null);
    const lookup = createEnteredGate();
    const read = entryReader.withSessionEntryReadOnlyInWorker;
    vi.spyOn(entryReader, "readSessionEntryReadOnlyInWorker").mockImplementation(
      (scope, assertCurrent = () => {}) =>
        read(scope, assertCurrent, async (result) => {
          await lookup.wait();
          if (!result.ok) {
            throw result.error;
          }
          return result.value;
        }),
    );
    let current = true;
    const controller = new AbortController();
    const revoke = () => {
      if (revocation === "cancellation") {
        controller.abort(new Error("request cancelled"));
      } else if (revocation === "generation") {
        rotateAgentEventLifecycleGeneration();
      } else {
        current = false;
      }
    };
    if (phase === "admission") {
      const create = imageGenerationTaskLifecycle.createTaskRun;
      vi.spyOn(imageGenerationTaskLifecycle, "createTaskRun").mockImplementationOnce(
        async (params) => {
          const handle = await create(params);
          revoke();
          return handle;
        },
      );
    }
    const run = vi.fn();
    const schedule = vi.fn();
    const release = vi.fn(async () => {});
    const pending = withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        operationalRunInstance: { runId: "run", instanceId: "instance" },
        receiptAuthority: () => current,
        approvalSignals: [controller.signal],
      },
      () =>
        runTask({
          scheduleBackgroundWork: schedule,
          resources: { run: async (work) => work(), release },
          run,
        }),
    ).catch((error: unknown) => error);
    await lookup.entered;
    if (phase === "lookup") {
      revoke();
    }
    lookup.release();
    expect(await pending).toBeInstanceOf(Error);
    expect(run).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(listMediaGenerationOperations(sessionKey, "main")).toEqual(
      phase === "admission" && revocation !== "generation"
        ? [expect.objectContaining({ status: "failed" })]
        : [],
    );
    expect(hasPending(sessionKey, "main")).toBe(false);
  });
});
it.each([
  ["current", 3, 2],
  ["reset-before-staging", 0, undefined],
  ["recreate-before-staging", 0, undefined],
  ["reset-during-acquisition", 0, undefined],
  ["reset-after-gitignore", 1, undefined],
  ["reset-after-first-output", 2, 1],
] as const)(
  "binds detached staging to the admitted session: %s",
  async (transition, writes, staged) => {
    await withOpenClawTestState({ prefix: "media-staging-" }, async (state) => {
      const workspace = state.workspaceDir;
      await fs.mkdir(workspace, { recursive: true });
      const outputBytes = Buffer.from("synthetic generated media");
      const attachments = ["image.png", "second.png"].map((name) => ({
        type: "image" as const,
        path: state.path(name),
      }));
      await Promise.all(
        attachments.map((attachment) => fs.writeFile(attachment.path, outputBytes)),
      );
      const sandbox = { root: workspace, bridge: createHostSandboxFsBridge(workspace) };
      const { scope, entry } = await requester(state);
      const lifecycle = createMediaGenerationTaskLifecycle("image");
      const handle = await lifecycle.createTaskRun({
        sessionKey,
        requesterAgentId: "main",
        prompt: "synthetic images",
      });
      assert(handle?.detach, "Expected an admitted detached generation");
      const invalidate = async () => {
        if (transition === "recreate-before-staging") {
          await deleteRequester(scope);
          await replaceSessionEntry(scope, {
            sessionId: "successor",
            lifecycleRevision: "successor",
            updatedAt: 2,
          });
        } else {
          await resetSessionEntryLifecycle({
            ...scope,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
            resetBoundary: { context: "clear", reason: "reset", cwd: workspace },
            buildNextEntry: () => ({ ...entry, lifecycleRevision: "successor", updatedAt: 2 }),
          });
        }
      };
      const createFile = sandbox.bridge.createFileExclusive!.bind(sandbox.bridge);
      const written = vi
        .spyOn(sandbox.bridge, "createFileExclusive")
        .mockImplementation(async (request) => {
          const result = await createFile(request);
          if (
            (transition === "reset-after-gitignore" && request.filePath.endsWith(".gitignore")) ||
            (transition === "reset-after-first-output" && request.filePath.endsWith("/image.png"))
          ) {
            await invalidate();
          }
          return result;
        });
      const acquire = vi.fn(async () => {
        if (transition === "reset-during-acquisition") {
          await invalidate();
        }
        return { ...sandbox, [Symbol.dispose]() {} };
      });
      if (transition.endsWith("before-staging")) {
        await invalidate();
      }
      const result = await buildResult({
        kind: "image",
        result: { provider: "test", model: "test", attempts: [] },
        maxBytes: 1024,
        details: {},
        attachments,
        mediaUrls: attachments.map((attachment) => attachment.path),
        sandbox: acquire,
        taskHandle: handle,
      });
      expect(result.attachments).toEqual(attachments);
      for (const attachment of attachments) {
        await expect(fs.readFile(attachment.path)).resolves.toEqual(outputBytes);
      }
      expect(written).toHaveBeenCalledTimes(writes);
      if (staged === undefined) {
        expect(result.details.sandboxPaths).toBeUndefined();
      } else {
        expect(result.details.sandboxPaths).toHaveLength(staged);
      }
      if (transition === "current") {
        const paths = result.details.sandboxPaths as string[];
        for (const relativePath of paths) {
          await expect(fs.readFile(path.join(workspace, relativePath))).resolves.toEqual(
            outputBytes,
          );
        }
      } else {
        expect(result.wakeResult).toContain(
          "Sandbox copy unavailable: Error: The requesting session is no longer current",
        );
        if (transition.endsWith("before-staging")) {
          expect(acquire).not.toHaveBeenCalled();
        }
        if (writes === 0) {
          await expect(fs.readdir(workspace)).resolves.toEqual([]);
        }
      }
    });
  },
);
