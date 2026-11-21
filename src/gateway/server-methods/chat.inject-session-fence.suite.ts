import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import * as gatewaySessionWorker from "../session-utils-store-worker.js";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

type InjectFenceFixture = {
  mockState: { sessionId: string; storePath: string; transcriptPath: string };
  createTranscriptFixture: (prefix: string) => Promise<unknown>;
  createChatRequestFixture: () => {
    context: GatewayRequestContext;
    respond: Mock<RespondFn>;
    inject: (params: GatewayRequestHandlerOptions["params"]) => void | Promise<void>;
  };
  readTranscriptJsonLines: (path: string) => unknown[];
  seedSqliteSessionEntry: (entry: Record<string, unknown>) => Promise<void>;
  signal: () => AbortSignal;
};

export function registerChatInjectSessionFenceTests(fixture: InjectFenceFixture) {
  const {
    mockState,
    createTranscriptFixture,
    createChatRequestFixture,
    readTranscriptJsonLines,
    seedSqliteSessionEntry,
  } = fixture;
  it.each([
    { name: "matching physical session", session: "current", expected: true },
    { name: "stale physical session", session: "old-incarnation", expected: false },
    { name: "legacy caller", session: undefined, expected: true },
  ])("chat.inject binds $name before writing", async ({ session, expected }) => {
    await createTranscriptFixture("openclaw-chat-inject-session-fence-");
    const { context, respond, inject } = createChatRequestFixture();
    await inject({
      sessionKey: "main",
      message: "synthetic passive context",
      ...(session ? { sessionId: session === "current" ? mockState.sessionId : session } : {}),
    });
    expect(respond.mock.calls.at(-1)?.[0]).toBe(expected);
    expect(readTranscriptJsonLines(mockState.transcriptPath)).toHaveLength(expected ? 2 : 1);
    if (!expected) {
      expect(context.broadcast).not.toHaveBeenCalled();
    }
  });

  it("chat.inject rejects an owner guard denial before appending", async () => {
    await createTranscriptFixture("openclaw-chat-inject-owner-guard-");
    const { context, respond } = createChatRequestFixture();
    await expectDefined(
      chatHandlers["chat.inject"],
      "chat.inject handler",
    )({
      params: { sessionKey: "main", sessionId: mockState.sessionId, message: "must not write" },
      respond,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context,
      sessionMutationCommitGuard: () => {
        throw new Error("authorization denied");
      },
    });
    expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
    expect(readTranscriptJsonLines(mockState.transcriptPath)).toHaveLength(1);
    expect(context.broadcast).not.toHaveBeenCalled();
  });

  it("chat.inject rejects revoked authority while waiting for write custody", async () => {
    await createTranscriptFixture("openclaw-chat-inject-authority-race-");
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const sessionSelected = createDeferred();
    const { loadGatewaySessionEntryReadOnlyInWorker } = await vi.importActual<
      typeof import("../session-utils-store-worker.js")
    >("../session-utils-store-worker.js");
    const readSession = vi
      .spyOn(gatewaySessionWorker, "loadGatewaySessionEntryReadOnlyInWorker")
      .mockImplementationOnce(async (params) =>
        loadGatewaySessionEntryReadOnlyInWorker({
          ...params,
          onSelected: (target) => {
            params.onSelected?.(target);
            sessionSelected.resolve();
          },
        }),
      );
    const mutation = runSessionMutation({
      scope: mockState.storePath,
      identities: ["main", mockState.sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
    });
    await mutationStarted.promise;
    const { context, respond } = createChatRequestFixture();
    let revoked = false;
    try {
      const pending = expectDefined(
        chatHandlers["chat.inject"],
        "chat.inject handler",
      )({
        params: { sessionKey: "main", sessionId: mockState.sessionId, message: "must not write" },
        respond,
        req: {} as never,
        client: null as never,
        isWebchatConnect: () => false,
        context,
        sessionMutationCommitGuard: () => {
          if (revoked) {
            throw new Error("authorization revoked");
          }
        },
      });
      await withinTest(sessionSelected.promise, fixture.signal());
      revoked = true;
      releaseMutation.resolve();
      await mutation;
      await pending;
      expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
      expect(readTranscriptJsonLines(mockState.transcriptPath)).toHaveLength(1);
      expect(context.broadcast).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      await mutation;
      readSession.mockRestore();
    }
  });

  it("chat.inject rejects reset while waiting for write custody", async () => {
    await createTranscriptFixture("openclaw-chat-inject-reset-race-");
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const sessionSelected = createDeferred();
    const { loadGatewaySessionEntryReadOnlyInWorker } = await vi.importActual<
      typeof import("../session-utils-store-worker.js")
    >("../session-utils-store-worker.js");
    const readSession = vi
      .spyOn(gatewaySessionWorker, "loadGatewaySessionEntryReadOnlyInWorker")
      .mockImplementationOnce(async (params) =>
        loadGatewaySessionEntryReadOnlyInWorker({
          ...params,
          onSelected: (target) => {
            params.onSelected?.(target);
            sessionSelected.resolve();
          },
        }),
      );
    const mutation = runSessionMutation({
      scope: mockState.storePath,
      identities: ["main", mockState.sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        await seedSqliteSessionEntry({ sessionId: "replacement-session" });
      },
    });
    await mutationStarted.promise;
    const { context, respond, inject } = createChatRequestFixture();
    try {
      const pending = inject({
        sessionKey: "main",
        sessionId: mockState.sessionId,
        message: "must not move",
      });
      await withinTest(sessionSelected.promise, fixture.signal());
      releaseMutation.resolve();
      await mutation;
      await pending;
      expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
      expect(readTranscriptJsonLines(mockState.transcriptPath)).toHaveLength(1);
      expect(context.broadcast).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      await mutation;
      readSession.mockRestore();
    }
  });

  it("chat.inject rechecks archive state after lifecycle admission waits", async () => {
    await createTranscriptFixture("openclaw-chat-inject-archive-race-");
    const storePath = mockState.storePath;
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const sessionSelected = createDeferred();
    const { loadGatewaySessionEntryReadOnlyInWorker } = await vi.importActual<
      typeof import("../session-utils-store-worker.js")
    >("../session-utils-store-worker.js");
    const readSession = vi
      .spyOn(gatewaySessionWorker, "loadGatewaySessionEntryReadOnlyInWorker")
      .mockImplementationOnce(async (params) =>
        loadGatewaySessionEntryReadOnlyInWorker({
          ...params,
          onSelected: (target) => {
            params.onSelected?.(target);
            sessionSelected.resolve();
          },
        }),
      );
    const mutation = runSessionMutation({
      scope: storePath,
      identities: ["main", mockState.sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        await seedSqliteSessionEntry({ archivedAt: Date.now() });
      },
    });
    await mutationStarted.promise;
    const { context, respond } = createChatRequestFixture();

    try {
      const inject = expectDefined(
        chatHandlers["chat.inject"],
        'chatHandlers["chat.inject"] test invariant',
      )({
        params: { sessionKey: "main", message: "must lose the archive race" },
        respond,
        req: {} as never,
        client: null as never,
        isWebchatConnect: () => false,
        context,
      });
      await withinTest(sessionSelected.promise, fixture.signal());
      releaseMutation.resolve();
      await mutation;
      await inject;

      const response = respond.mock.calls.at(-1);
      expect(response?.[0]).toBe(false);
      expect(response?.[2]?.message).toMatch(/archived/i);
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(readTranscriptJsonLines(mockState.transcriptPath)).toHaveLength(1);
    } finally {
      releaseMutation.resolve();
      await mutation;
      readSession.mockRestore();
    }
  });
}
