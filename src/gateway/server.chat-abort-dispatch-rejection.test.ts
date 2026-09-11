// Real WebSocket coverage for abort ownership when an in-flight dispatch rejects.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import * as staging from "../auto-reply/reply/stage-sandbox-media.js";
import { clearConfigCache } from "../config/config.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  getSessionWorkAdmissionRelease,
  interruptSessionWorkAdmissions,
  startSessionWorkAdmissionInterruption,
} from "../sessions/session-lifecycle-admission.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const temporaryDirectories = useAutoCleanupTempDirTracker(afterEach);
type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
let gateway: GatewayHarness;
const connectionReleases: Promise<void>[] = [];
let restoreConnectionObserver: (() => void) | undefined;

function trackChatTerminalStates(socket: GatewaySocket, runId: string): string[] {
  const terminalStates: string[] = [];
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(rawDataToString(raw)) as {
        type?: string;
        event?: string;
        payload?: { runId?: string; state?: string };
      };
      if (
        frame.type === "event" &&
        frame.event === "chat" &&
        frame.payload?.runId === runId &&
        typeof frame.payload.state === "string"
      ) {
        terminalStates.push(frame.payload.state);
      }
    } catch {
      // The owned test socket may also carry unrelated gateway events.
    }
  });
  return terminalStates;
}

beforeAll(async () => {
  const kernelModule = await import("./server-kernel.js");
  const createKernel = kernelModule.createGatewayKernel;
  const factory = vi
    .spyOn(kernelModule, "createGatewayKernel")
    .mockImplementationOnce(async (...args) => {
      const kernel = await createKernel(...args);
      const register = kernel.connectionWork.registerConnection.bind(kernel.connectionWork);
      const registration = vi
        .spyOn(kernel.connectionWork, "registerConnection")
        .mockImplementation((close) => {
          const release = register(close);
          const released = createDeferred();
          connectionReleases.push(released.promise);
          return () => {
            release();
            released.resolve();
          };
        });
      restoreConnectionObserver = () => registration.mockRestore();
      return kernel;
    });
  try {
    gateway = await createGatewaySuiteHarness();
  } finally {
    factory.mockRestore();
  }
});

afterAll(async () => {
  await gateway.close();
  restoreConnectionObserver?.();
});

afterEach(() => {
  dispatchInboundMessageMock.mockReset();
  testState.sessionStorePath = undefined;
  clearConfigCache();
});

describe("gateway WebSocket chat abort ownership", () => {
  test.each(["bound", "omitted"] as const)(
    "preserves committed native input across a real reconnect with %s expected profile",
    async (binding) => {
      const sessionDirectory = temporaryDirectories.make("openclaw-chat-native-reconnect-");
      const storePath = path.join(sessionDirectory, "sessions.json");
      testState.sessionStorePath = storePath;
      const scope = {
        storePath,
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: `native-reconnect-${binding}`,
      };
      await writeSessionStore({
        entries: { main: { sessionId: scope.sessionId, updatedAt: Date.now() } },
      });
      const runId = `real-websocket-native-reconnect-${binding}`;
      const sendParameters = {
        sessionKey: scope.sessionKey,
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        message: "Keep the accepted native turn alive across reconnect.",
        idempotencyKey: runId,
      };
      const client = {
        id: "openclaw-macos",
        version: "test",
        platform: "darwin",
        mode: "ui",
      } as const;
      const dispatchRelease = createDeferred();
      const inputPersisted = createDeferred<{
        recorder: UserTurnTranscriptRecorder;
        signal: AbortSignal;
        result: Awaited<ReturnType<UserTurnTranscriptRecorder["persistApproved"]>>;
      }>();
      const connectionOffset = connectionReleases.length;
      const sockets: Array<{ socket: GatewaySocket; closed: Promise<void> }> = [];
      const frames: Promise<unknown>[] = [];
      const dispatches: Array<ReturnType<typeof dispatchInboundMessage>> = [];
      let admissionRelease: Promise<void> | undefined;
      const ownFrame = <T>(frame: Promise<T>) => {
        frames.push(frame);
        void frame.catch(() => {});
        return frame;
      };
      void inputPersisted.promise.catch(() => {});
      const isUserMessage = (event: unknown) => {
        const entry = asOptionalRecord(event);
        return entry?.type === "message" && asOptionalRecord(entry.message)?.role === "user";
      };
      const openSocket = async () => {
        const index = connectionReleases.length;
        const socket = await gateway.openWs();
        const closed = new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
        });
        sockets.push({ socket, closed });
        // Opens are serialized; exactly one server registration identifies this socket.
        expect(connectionReleases).toHaveLength(index + 1);
        const released = connectionReleases[index];
        if (!released) {
          throw new Error("Gateway socket did not register with its connection owner");
        }
        await connectOk(socket, { client });
        return { socket, closed, released };
      };
      const send = async (socket: GatewaySocket, expectedProfileId?: string) => {
        // Raw request frames need the same prepared reply runtime as rpcReq.
        await prepareGatewayReplyRuntimeForTest();
        const id = randomUUID();
        const response = ownFrame(
          onceMessage<Awaited<ReturnType<typeof rpcReq>>>(
            socket,
            (frame) => frame.type === "res" && frame.id === id,
          ),
        );
        socket.send(
          JSON.stringify({
            type: "req",
            id,
            method: "chat.send",
            params: sendParameters,
            ...(expectedProfileId === undefined ? {} : { expectedProfileId }),
          }),
        );
        return await response;
      };
      dispatchInboundMessageMock.mockImplementation((args: unknown) => {
        const { dispatcher, replyOptions } = args as Parameters<typeof dispatchInboundMessage>[0];
        const dispatchWork = (async () => {
          const recorder = replyOptions?.userTurnTranscriptRecorder;
          const signal = replyOptions?.abortSignal;
          if (!recorder || !signal) {
            throw new Error("Native dispatch must retain its recorder and admitted abort signal");
          }
          const result = await recorder.persistApproved();
          inputPersisted.resolve({ recorder, signal, result });
          await dispatchRelease.promise;
          dispatcher.sendFinalReply({ text: "The original accepted turn finished." });
          return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
        })();
        dispatches.push(dispatchWork);
        void dispatchWork.catch(inputPersisted.reject);
        return dispatchWork;
      });

      await runQaGatewayFixture(
        async () => {
          const original = await openSocket();
          const self = await rpcReq<{ profile: { id: string } }>(original.socket, "users.self", {});
          expect(self.ok).toBe(true);
          const profileId = self.payload?.profile.id;
          if (!profileId) {
            throw new Error("Native socket must expose its canonical authenticated profile");
          }
          const expectedProfileId = binding === "bound" ? profileId : undefined;
          const started = await send(original.socket, expectedProfileId);
          expect(started.ok).toBe(true);
          expect(started.payload).toMatchObject({ runId, status: "started" });
          await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledOnce(), {
            interval: 10,
            timeout: 2_000,
          });
          const { recorder, signal, result } = await inputPersisted.promise;
          expect(result).toMatchObject({ appended: true });
          const receipt = structuredClone(recorder.getAdmissionReceipt());
          expect(receipt).toMatchObject({
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
            sessionId: scope.sessionId,
            entryId: result?.messageId,
            role: "user",
          });
          const accepted = loadTranscriptEventsSync(scope);
          const userRows = accepted.filter(isUserMessage);
          expect(userRows).toHaveLength(1);
          expect(userRows[0]).toMatchObject({
            id: receipt?.entryId,
            message: { content: sendParameters.message },
          });
          expect(signal.aborted).toBe(false);
          admissionRelease = getSessionWorkAdmissionRelease({
            scope: storePath,
            identities: [scope.sessionKey, scope.sessionId],
          });
          expect(admissionRelease).toBeDefined();
          if (!admissionRelease) {
            throw new Error("Accepted native work must retain its session admission");
          }

          original.socket.close();
          await original.closed;
          await original.released;
          const reconnected = await openSocket();
          const reconnectedSelf = await rpcReq<{ profile: { id: string } }>(
            reconnected.socket,
            "users.self",
            {},
          );
          expect(reconnectedSelf.ok).toBe(true);
          expect(reconnectedSelf.payload?.profile.id).toBe(profileId);
          const expectRetainedInput = () => {
            expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
            expect(signal.aborted).toBe(false);
            expect(loadTranscriptEventsSync(scope)).toEqual(accepted);
            expect(recorder.getAdmissionReceipt()).toEqual(receipt);
          };
          const retry = await send(reconnected.socket, expectedProfileId);
          expect(retry.ok).toBe(true);
          expect(retry.payload).toMatchObject({ runId, status: "in_flight" });
          expectRetainedInput();
          if (binding === "bound") {
            const wrongProfile = "unselected-native-profile";
            expect(wrongProfile).not.toBe(profileId);
            const rejected = await send(reconnected.socket, wrongProfile);
            expect(rejected.ok).toBe(false);
            expect(rejected.error?.details).toEqual({
              reason: "EXPECTED_PROFILE_MISMATCH",
              execution: "not_started",
            });
            expectRetainedInput();
            const correctRetry = await send(reconnected.socket, profileId);
            expect(correctRetry.ok).toBe(true);
            expect(correctRetry.payload).toMatchObject({ runId, status: "in_flight" });
            expectRetainedInput();
          }

          const terminal = ownFrame(
            onceMessage(
              reconnected.socket,
              (frame) =>
                frame.type === "event" &&
                frame.event === "chat" &&
                frame.payload?.runId === runId &&
                frame.payload?.state === "final",
            ),
          );
          dispatchRelease.resolve();
          await expect(terminal).resolves.toMatchObject({ payload: { runId, state: "final" } });
          await Promise.all(dispatches);
          await admissionRelease;
          const completed = loadTranscriptEventsSync(scope);
          expect(completed.filter(isUserMessage)).toEqual(userRows);
          expect(completed).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
            ]),
          );
          const replay = await send(reconnected.socket, expectedProfileId);
          expect(replay.ok).toBe(true);
          expect(replay.payload).toMatchObject({ runId, status: "ok" });
          expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
          expect(loadTranscriptEventsSync(scope)).toEqual(completed);
          expect(recorder.getAdmissionReceipt()).toEqual(receipt);
        },
        async () => {
          admissionRelease ??= getSessionWorkAdmissionRelease({
            scope: storePath,
            identities: [scope.sessionKey, scope.sessionId],
          });
          dispatchRelease.resolve();
          await runQaGatewayFixture(
            async () => {
              await admissionRelease;
            },
            ...dispatches.map((work) => () => work),
          );
        },
        async () => {
          for (const { socket } of sockets) {
            socket.close();
          }
          await Promise.all([
            ...sockets.map(({ closed }) => closed),
            ...connectionReleases.slice(connectionOffset),
          ]);
        },
        async () => {
          await Promise.allSettled(frames);
        },
      );
    },
  );

  test("does not replace an acknowledged abort with a later dispatch rejection", async () => {
    const sessionDirectory = temporaryDirectories.make("openclaw-chat-abort-dispatch-");
    testState.sessionStorePath = path.join(sessionDirectory, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    const socket = await gateway.openWs();
    const dispatchRelease = createDeferred();
    const runId = "real-websocket-explicit-abort-before-dispatch-rejection";
    let dispatchRejected = false;
    const terminalStates = trackChatTerminalStates(socket, runId);

    try {
      await connectOk(socket);
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        await dispatchRelease.promise;
        dispatchRejected = true;
        throw new Error("dispatch rejected after an explicitly aborted run");
      });

      const sendParameters = {
        sessionKey: "main",
        message: "abort this dispatched message",
        idempotencyKey: runId,
      };
      const started = await rpcReq(socket, "chat.send", sendParameters);
      expect(started.ok).toBe(true);
      expect(started.payload).toMatchObject({ runId, status: "started" });
      await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledOnce(), {
        interval: 10,
        timeout: 2_000,
      });

      const abortedFrame = onceMessage(
        socket,
        (frame) =>
          frame.type === "event" &&
          frame.event === "chat" &&
          frame.payload?.runId === runId &&
          frame.payload?.state === "aborted",
        2_000,
      );
      const aborted = await rpcReq(socket, "chat.abort", {
        sessionKey: "main",
        runId,
      });
      expect(aborted.ok).toBe(true);
      expect(aborted.payload).toMatchObject({ ok: true, aborted: true, runIds: [runId] });
      await expect(abortedFrame).resolves.toMatchObject({
        payload: { runId, state: "aborted" },
      });

      dispatchRelease.resolve();
      await vi.waitFor(() => expect(dispatchRejected).toBe(true), {
        interval: 10,
        timeout: 2_000,
      });

      // The replay response is a real WebSocket ordering barrier: any prior
      // contradictory terminal frame must arrive before this cached response.
      const replay = await rpcReq(socket, "chat.send", sendParameters);
      expect(replay.ok).toBe(true);
      expect(replay.payload).toMatchObject({ runId, status: "timeout", summary: "aborted" });
      expect(terminalStates).toEqual(["aborted"]);
    } finally {
      dispatchRelease.resolve();
      socket.close();
    }
  });

  test("does not let a late abort replace an established dispatch error", async () => {
    const sessionDirectory = temporaryDirectories.make("openclaw-chat-error-late-abort-");
    testState.sessionStorePath = path.join(sessionDirectory, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    const socket = await gateway.openWs();
    const dispatchRelease = createDeferred();
    const runId = "real-websocket-dispatch-error-before-late-abort";
    const terminalStates = trackChatTerminalStates(socket, runId);

    try {
      await connectOk(socket);
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        await dispatchRelease.promise;
        throw new Error("dispatch rejected before a late abort");
      });

      const sendParameters = {
        sessionKey: "main",
        message: "reject this dispatched message before the abort",
        idempotencyKey: runId,
      };
      const started = await rpcReq(socket, "chat.send", sendParameters);
      expect(started.ok).toBe(true);
      expect(started.payload).toMatchObject({ runId, status: "started" });
      await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledOnce(), {
        interval: 10,
        timeout: 2_000,
      });

      const errorFrame = onceMessage(
        socket,
        (frame) =>
          frame.type === "event" &&
          frame.event === "chat" &&
          frame.payload?.runId === runId &&
          frame.payload?.state === "error",
        2_000,
      );
      dispatchRelease.resolve();
      await expect(errorFrame).resolves.toMatchObject({
        payload: { runId, state: "error" },
      });

      const lateAbort = await rpcReq(socket, "chat.abort", {
        sessionKey: "main",
        runId,
      });
      expect(lateAbort.ok).toBe(true);
      expect(lateAbort.payload).toMatchObject({ ok: true, aborted: false, runIds: [] });

      const replay = await rpcReq(socket, "chat.send", sendParameters);
      expect(replay.ok).toBe(false);
      expect(replay.payload).toMatchObject({ runId, status: "error" });
      expect(terminalStates).toEqual(["error"]);
    } finally {
      dispatchRelease.resolve();
      socket.close();
    }
  });

  test("keeps a real signal-only lifecycle terminal as the only chat terminal", async () => {
    const sessionDirectory = temporaryDirectories.make("openclaw-chat-lifecycle-interrupt-");
    const storePath = path.join(sessionDirectory, "sessions.json");
    testState.sessionStorePath = storePath;
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          startedAt: 900,
          status: "running",
          updatedAt: Date.now(),
        },
      },
    });

    const socket = await gateway.openWs();
    const dispatchRelease = createDeferred();
    const runId = "real-websocket-signal-only-lifecycle-terminal";
    const terminalStates = trackChatTerminalStates(socket, runId);
    let capturedAbortSignal: AbortSignal | undefined;
    let dispatchRejected = false;
    let interruption: Promise<boolean> | undefined;

    try {
      await connectOk(socket);
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        capturedAbortSignal = (args as { replyOptions?: GetReplyOptions }).replyOptions
          ?.abortSignal;
        await new Promise<void>((resolve) => {
          if (capturedAbortSignal?.aborted) {
            resolve();
            return;
          }
          capturedAbortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await dispatchRelease.promise;
        dispatchRejected = true;
        throw capturedAbortSignal?.reason instanceof Error
          ? capturedAbortSignal.reason
          : new Error("lifecycle interrupted dispatch");
      });

      const started = await rpcReq(socket, "chat.send", {
        sessionKey: "main",
        message: "preserve the signal-only lifecycle terminal",
        idempotencyKey: runId,
      });
      expect(started.ok).toBe(true);
      expect(started.payload).toMatchObject({ runId, status: "started" });
      await vi.waitFor(() => expect(capturedAbortSignal).toBeDefined(), {
        interval: 10,
        timeout: 2_000,
      });

      interruption = interruptSessionWorkAdmissions({
        scope: storePath,
        identities: ["main", "agent:main:main", "sess-main"],
        timeoutMs: 1_000,
      });
      await vi.waitFor(() => expect(capturedAbortSignal?.aborted).toBe(true), {
        interval: 10,
        timeout: 2_000,
      });

      const abortedFrame = onceMessage(
        socket,
        (frame) =>
          frame.type === "event" &&
          frame.event === "chat" &&
          frame.payload?.runId === runId &&
          frame.payload?.state === "aborted",
        2_000,
      );
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        agentId: "main",
        data: {
          phase: "end",
          startedAt: 900,
          endedAt: Date.now(),
          aborted: true,
          stopReason: "restart",
        },
      });
      await expect(abortedFrame).resolves.toMatchObject({
        payload: { runId, state: "aborted" },
      });

      dispatchRelease.resolve();
      await vi.waitFor(() => expect(dispatchRejected).toBe(true), {
        interval: 10,
        timeout: 2_000,
      });
      await expect(interruption).resolves.toBe(true);

      // The history RPC response follows every previously emitted chat
      // event on this socket, so it exposes any contradictory late terminal.
      const barrier = await rpcReq(socket, "chat.history", { sessionKey: "main" });
      expect(barrier.ok).toBe(true);
      expect(terminalStates).toEqual(["aborted"]);
    } finally {
      dispatchRelease.resolve();
      await interruption?.catch(() => undefined);
      socket.close();
    }
  });

  test("returns pre-ACK attachment cancellation only after inbound cleanup", async () => {
    const sessionDirectory = temporaryDirectories.make("openclaw-chat-attachment-abort-");
    const storePath = path.join(sessionDirectory, "sessions.json");
    testState.sessionStorePath = storePath;
    const previousAgentConfig = testState.agentConfig;
    testState.agentConfig = {
      ...previousAgentConfig,
      workspace: path.join(sessionDirectory, "workspace"),
      skipBootstrap: true,
      sandbox: {
        mode: "all",
        scope: "agent",
        workspaceRoot: path.join(sessionDirectory, "sandboxes"),
        workspaceAccess: "none",
      },
    };
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-attachment-abort", updatedAt: Date.now() },
      },
    });

    const socket = await gateway.openWs();
    const stageRelease = createDeferred();
    const stageEntered = createDeferred();
    const reason = createAgentRunDirectAbortError();
    const runId = "real-websocket-pre-ack-attachment-cancellation";
    const bytes = "synthetic attachment awaiting staging";
    let inboundPath: string | undefined;
    let filePresentAtResponse: boolean | undefined;
    let interruption: ReturnType<typeof startSessionWorkAdmissionInterruption> | undefined;
    let send: ReturnType<typeof rpcReq> | undefined;
    const stageSpy = vi.spyOn(staging, "stageSandboxMedia").mockImplementation(async ({ ctx }) => {
      inboundPath = ctx.media?.[0]?.path;
      stageEntered.resolve();
      await stageRelease.promise;
      throw reason;
    });

    try {
      await connectOk(socket);
      dispatchInboundMessageMock.mockResolvedValue({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      });
      send = rpcReq(socket, "chat.send", {
        sessionKey: "main",
        message: "cancel this attachment before dispatch",
        idempotencyKey: runId,
        attachments: [
          {
            fileName: "notes.txt",
            mimeType: "text/plain",
            content: Buffer.from(bytes).toString("base64"),
          },
        ],
      }).then((response) => {
        filePresentAtResponse = inboundPath !== undefined && existsSync(inboundPath);
        return response;
      });
      // Cancel at the staging boundary, independently of RPC setup and filesystem latency.
      await Promise.race([
        stageEntered.promise,
        send.then(() => {
          throw new Error("chat.send completed before attachment staging");
        }),
      ]);
      expect(stageSpy).toHaveBeenCalledOnce();
      if (!inboundPath) {
        throw new Error("the real Gateway did not persist the inbound attachment");
      }
      expect(await fs.readFile(inboundPath, "utf8")).toBe(bytes);
      // This is the real admitted-work interruption path after registration,
      // which forwards its reason without creating an explicit RPC abort marker.
      interruption = startSessionWorkAdmissionInterruption({
        scope: storePath,
        identities: ["main", "agent:main:main", "sess-attachment-abort"],
        reason,
      });
      stageRelease.resolve();
      const response = await send;
      expect(response.ok).toBe(true);
      expect(response.payload).toMatchObject({
        runId,
        status: "timeout",
        summary: "aborted",
        stopReason: "rpc",
      });
      expect(filePresentAtResponse).toBe(false);
      await expect(interruption.released).resolves.toBeUndefined();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      stageRelease.resolve();
      await Promise.allSettled([send, interruption?.released]);
      stageSpy.mockRestore();
      testState.agentConfig = previousAgentConfig;
      socket.close();
    }
  });

  test("waits for pass-through attachment cleanup after sessions.abort before replying to chat.send", async () => {
    const sessionDirectory = temporaryDirectories.make("openclaw-chat-pass-through-abort-");
    testState.sessionStorePath = path.join(sessionDirectory, "sessions.json");
    const previousAgentConfig = testState.agentConfig;
    const prepared = createDeferred();
    const releasePreparation = createDeferred();
    const discarding = createDeferred();
    const releaseDiscard = createDeferred();
    const runId = "real-websocket-pass-through-sessions-abort";
    const bytes = "synthetic pass-through attachment awaiting cancellation";
    let socket: GatewaySocket | undefined;
    let send: ReturnType<typeof rpcReq> | undefined;
    let sendWork: Promise<void> | undefined;
    let discardWork: Promise<void> | undefined;
    let inboundPath: string | undefined;
    let cleanupSettled = false;
    const responses: Array<{
      filePresent: boolean;
      cleanupSettled: boolean;
      payload: unknown;
    }> = [];
    const restoreSpies: Array<() => void> = [];
    await runQaGatewayFixture(
      async () => {
        testState.agentConfig = {
          ...previousAgentConfig,
          workspace: path.join(sessionDirectory, "workspace"),
          skipBootstrap: true,
          sandbox: { mode: "off" },
        };
        await writeSessionStore({
          entries: { main: { sessionId: "sess-pass-through-abort", updatedAt: Date.now() } },
        });
        // Eager chat.send imports bind the real dispatcher before fixture mocks exist.
        const [sandboxContext, attachments, chatSend] = await Promise.all([
          import("../agents/sandbox/context.js"),
          import("./chat-attachments.js"),
          import("./server-methods/chat-send-handler.js"),
        ]);
        const parse = attachments.parseMessageWithAttachments;
        const ensureSandbox = sandboxContext.ensureSandboxWorkspaceForSession;
        const discard = attachments.discardPreparedInboundMedia;
        const handleSend = chatSend.handleChatSend;
        const parseSpy = vi
          .spyOn(attachments, "parseMessageWithAttachments")
          .mockImplementation(async (...args) => {
            const result = await parse(...args);
            inboundPath = result.offloadedRefs[0]?.path;
            return result;
          });
        restoreSpies.push(() => parseSpy.mockRestore());
        const sandboxSpy = vi
          .spyOn(sandboxContext, "ensureSandboxWorkspaceForSession")
          .mockImplementation(async (...args) => {
            const result = await ensureSandbox(...args);
            if (inboundPath) {
              expect(result).toBeNull();
              prepared.resolve();
              await releasePreparation.promise;
            }
            return result;
          });
        restoreSpies.push(() => sandboxSpy.mockRestore());
        const discardSpy = vi
          .spyOn(attachments, "discardPreparedInboundMedia")
          .mockImplementation((...args) => {
            discardWork = releaseDiscard.promise.then(async () => {
              await discard(...args);
              cleanupSettled = true;
            });
            discarding.resolve();
            return discardWork;
          });
        restoreSpies.push(() => discardSpy.mockRestore());
        const sendSpy = vi
          .spyOn(chatSend, "handleChatSend")
          .mockImplementation((options, ...rest) => {
            const respond: typeof options.respond = (...reply) => {
              // Observe before wire scheduling can hide a premature response behind cleanup.
              responses.push({
                filePresent: inboundPath !== undefined && existsSync(inboundPath),
                cleanupSettled,
                payload: reply[1],
              });
              options.respond(...reply);
            };
            sendWork = handleSend({ ...options, respond }, ...rest);
            return sendWork;
          });
        restoreSpies.push(() => sendSpy.mockRestore());
        const connectedSocket = await gateway.openWs();
        socket = connectedSocket;
        await connectOk(connectedSocket);
        dispatchInboundMessageMock.mockResolvedValue({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        });
        send = rpcReq(connectedSocket, "chat.send", {
          sessionKey: "main",
          message: "cancel this pass-through attachment before dispatch",
          idempotencyKey: runId,
          attachments: [
            {
              fileName: "notes.txt",
              mimeType: "text/plain",
              content: Buffer.from(bytes).toString("base64"),
            },
          ],
        });
        await Promise.race([
          prepared.promise,
          send.then((response) => {
            throw new Error(
              `chat.send completed before real attachment preparation: ${JSON.stringify(response)}`,
            );
          }),
        ]);
        expect(parseSpy).toHaveBeenCalledOnce();
        if (!inboundPath) {
          throw new Error("the real parser did not persist the pass-through attachment");
        }
        expect(await fs.readFile(inboundPath, "utf8")).toBe(bytes);
        expect(responses).toEqual([]);
        const aborted = await rpcReq(connectedSocket, "sessions.abort", {
          key: "main",
          agentId: "main",
          clearQueued: true,
        });
        expect(aborted.ok).toBe(true);
        expect(aborted.payload).toEqual({ ok: true, abortedRunId: runId, status: "aborted" });
        releasePreparation.resolve();
        await Promise.race([
          discarding.promise,
          send.then(() => {
            throw new Error("chat.send completed without discarding the cancelled attachment");
          }),
        ]);
        expect(existsSync(inboundPath)).toBe(true);
        expect(cleanupSettled).toBe(false);
        expect(responses).toEqual([]);
        releaseDiscard.resolve();
        const response = await send;
        await sendWork;
        await discardWork;
        expect(response.ok).toBe(true);
        expect(response.payload).toMatchObject({
          runId,
          status: "timeout",
          summary: "aborted",
          stopReason: "rpc",
        });
        expect(responses).toEqual([
          {
            filePresent: false,
            cleanupSettled: true,
            payload: expect.objectContaining({
              runId,
              status: "timeout",
              summary: "aborted",
              stopReason: "rpc",
            }),
          },
        ]);
        expect(discardSpy).toHaveBeenCalledOnce();
        expect(existsSync(inboundPath)).toBe(false);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      },
      async () => {
        releasePreparation.resolve();
        releaseDiscard.resolve();
        await runQaGatewayFixture(
          async () => {
            await sendWork;
          },
          async () => {
            await discardWork;
          },
          async () => {
            await send;
          },
        );
      },
      () => {
        for (const restore of restoreSpies.toReversed()) {
          restore();
        }
        testState.agentConfig = previousAgentConfig;
        socket?.close();
      },
    );
  });
});
