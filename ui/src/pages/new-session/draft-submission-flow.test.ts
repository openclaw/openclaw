import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { SESSION_CREATE_RETRY_WINDOW_MS } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { requestSessionCreate, type SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { writeSessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import * as toast from "../../lib/toast.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { buildChatApiAttachments } from "../chat/attachment-api.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
} from "../chat/attachment-payload-store.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import {
  createDraftFixture as makeDraftFixture,
  backgroundCreateOptions,
  readyChatRoute,
  resetSubmissionMocks,
  registerTextPayload,
  stubObjectUrls,
} from "./draft-submission-flow.test-support.ts";

afterEach(resetSubmissionMocks);

const REMOTE_PROJECT = {
  identity: "openclaw/openclaw",
  cloneUrl: "https://github.com/openclaw/openclaw.git",
};
const placementAccess = {
  methods: ["sessions.create", "sessions.dispatch"],
  scopes: ["operator.admin", "operator.read", "operator.write"],
};
const noteAttachment = {
  id: "note",
  dataUrl: "data:text/plain;base64,SGk=",
  mimeType: "text/plain",
  fileName: "note.txt",
};

function createDraftFixture(...options: Parameters<typeof makeDraftFixture>) {
  const fixture = makeDraftFixture(...options);
  return { ...fixture, create: vi.mocked(fixture.context.sessions.createResult) };
}

function composerState(flow: ReturnType<typeof createDraftFixture>["flow"]) {
  return [flow.message, flow.mentions, flow.attachmentDraft.attachments];
}

describe("DraftSubmissionFlow", () => {
  it.each([false, true])(
    "keeps startup creation client-owned beyond four minutes (cancel=%s)",
    async (cancel) => {
      vi.useFakeTimers();
      const { create, flow } = createDraftFixture();
      const frames: string[] = [];
      let ready = false;
      let writes = 0;
      const pending = new GatewayPendingRequests({
        createRequestId: () => "startup-create",
        nowMs: Date.now,
        requestTimeoutMs: 30_000,
      });
      onTestFinished(() => pending.flush(new Error("test disposed")));
      const wire = {
        send(raw: string) {
          frames.push(raw);
          const request = JSON.parse(raw) as { id: string; method: string };
          writes += Number(ready);
          pending.handleResponse({
            type: "res",
            id: request.id,
            ok: ready,
            ...(ready
              ? { payload: { key: "agent:main:startup-created", runStarted: false } }
              : {
                  error: {
                    code: "UNAVAILABLE",
                    message: "Agent is preparing",
                    retryable: true,
                    retryAfterMs: 500,
                    details: { reason: "startup-sidecars", method: request.method },
                  },
                }),
          });
        },
      };
      const client = createTestGatewayClient((method, params, options) =>
        pending.request(wire, method, params, options),
      );
      create.mockImplementation((params, options) =>
        requestSessionCreate(client, params, options).catch(() => null),
      );
      flow.setMessage("Send after startup");
      const submission = flow.submit(undefined, true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pending.hasPending).toBe(true);
      expect(writes).toBe(0);
      if (cancel) {
        flow.invalidate();
        expect(pending.hasPending).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(210_000);
      ready = true;
      await vi.advanceTimersByTimeAsync(500);
      await submission;
      expect(writes).toBe(cancel ? 0 : 1);
      expect(new Set(frames).size).toBe(1);
      expect(pending.hasPending).toBe(false);
    },
  );

  it("publishes complete restored drafts and attachment-read changes", () => {
    const { flow } = createDraftFixture();
    const snapshots: ReturnType<typeof flow.composerDraft.read>[] = [];
    const stop = flow.composerDraft.subscribe(() => snapshots.push(flow.composerDraft.read()));
    try {
      const mentions = [{ profileId: "alex", start: 0, end: 5 }];
      flow.restoreDraftState({
        message: "@Alex restored",
        mentions,
        attachments: [],
        visibility: "normal",
      });
      expect(snapshots.at(-1)).toMatchObject({ draft: "@Alex restored", mentions });
      flow.restoreMessage("A replacement");
      expect(snapshots.at(-1)).toMatchObject({ draft: "A replacement", mentions: [] });
      const signal = flow.attachmentDraft.reads.readSignal;
      flow.attachmentDraft.reads.updatePending(signal, 1);
      expect(snapshots.at(-1)?.pendingAttachmentReads).toBe(1);
    } finally {
      stop();
      flow.disconnect();
    }
  });

  it.each(["available", "unavailable before create", "unavailable after create"] as const)(
    "preserves the runtime through Auto placement when recovery storage is %s",
    async (storage) => {
      const { context, create, flow, place } = createDraftFixture(placementAccess);
      place.applyPendingPlacement({ agentId: "main", profileId: "", autoDevice: true });
      place.modelControl.selected = "openai/gpt-5.6-sol";
      place.modelControl.agentRuntime = "codex";
      vi.spyOn(flow, "canSubmit").mockReturnValue(true);
      context.placementStartup.start = vi.fn();
      const failStorage = () => {
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new DOMException("storage disabled", "SecurityError");
        });
      };
      create.mockImplementation(async (params) => {
        if (storage === "unavailable after create") {
          failStorage();
        }
        return {
          key: expectDefined(params?.key, "Auto placement create key"),
          initialRun: { status: "idle" },
        };
      });
      vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
      flow.setMessage("Keep my model and runtime");
      if (storage === "unavailable before create") {
        failStorage();
      }

      await flow.submit();

      if (storage !== "unavailable before create") {
        expect(create.mock.calls[0]?.[0]).toMatchObject({
          worktree: true,
          model: "openai/gpt-5.6-sol",
          agentRuntime: "codex",
        });
      } else {
        expect(create).not.toHaveBeenCalled();
      }
      expect(context.placementStartup.start).toHaveBeenCalledTimes(Number(storage === "available"));
      if (storage !== "available") {
        expect(flow).toMatchObject({
          error:
            storage === "unavailable before create"
              ? "Couldn't prepare session recovery. Your draft has been kept."
              : "The session was created, but startup needs attention: placement recovery storage is unavailable",
          message: "Keep my model and runtime",
        });
      }
      flow.disconnect();
    },
  );

  it.each(["disabled uploads", "oversized attachments"])(
    "retains drafts with %s before creating a session",
    async (reason) => {
      const oversized = reason === "oversized attachments";
      const takePreparedTitle = vi.fn(() => "Review files");
      const { context, create, flow } = createDraftFixture({ takePreparedTitle });
      if (oversized) {
        expectDefined(context.gateway.snapshot.hello, "connected hello").policy = {
          maxPayload: 256 * 1024 + 2,
          attachments: { maxBytes: 10, maxImageBytes: 10 },
        };
      } else {
        context.config.current.uploadsEnabled = false;
      }
      const attachments = oversized
        ? ["first.txt", "second.txt"].map((fileName) => ({
            id: fileName,
            fileName,
            mimeType: "text/plain",
            dataUrl: "data:text/plain;base64,aQ==",
          }))
        : [registerTextPayload("retained-upload")];
      const mentions = oversized ? [{ profileId: "profile-alex", start: 0, end: 5 }] : [];
      const message = oversized ? "@Alex review these" : "Keep this prompt";
      flow.setMessage(message, mentions);
      if (oversized) {
        flow.attachmentDraft.replace(attachments);
      } else {
        flow.attachmentDraft.restore(attachments);
      }
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);

      await flow.submit();

      expect(create).not.toHaveBeenCalled();
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      expect(composerState(flow)).toEqual([message, mentions, attachments]);
      expect(flow.submitting).toBe(false);
      expect(takePreparedTitle).not.toHaveBeenCalled();
      if (oversized) {
        expect(showToast).toHaveBeenCalledExactlyOnceWith({
          message: "Too large to send: second.txt",
        });
      } else {
        expect(flow.error).toContain("uploads are disabled");
      }
      flow.disconnect();
    },
  );

  it.each(["navigation", "reconnect"])("retires only the captured draft after %s", async (mode) => {
    const { context, create, flow } = createDraftFixture();
    const accepted = createDeferred<SessionCreateOutcome>();
    create.mockReturnValueOnce(accepted.promise);
    flow.draftPersistence.setOwner("ws://gateway.example", "principal-a");
    flow.draftPersistence.selectRoute("original-route");
    flow.setMessage("  @Alex submitted prompt  ", [{ profileId: "alex", start: 2, end: 7 }]);
    stubObjectUrls("blob:submitted-file");
    const attachment = registerTextPayload("submitted-file");
    flow.attachmentDraft.replace([attachment]);
    const pending = flow.submit();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    flow.invalidate("gateway-changed");
    if (mode === "navigation") {
      flow.disconnect();
      flow.resetDraft();
      flow.draftPersistence.selectRoute("replacement-route");
      flow.setMessage("a newer prompt");
    }
    accepted.resolve({
      key: "agent:main:created",
      initialRun: { status: "started", runId: "created-run" },
    });
    await pending;
    expect(flow.message).toBe(mode === "navigation" ? "a newer prompt" : "");
    expect(flow).toMatchObject({ submitting: false, pendingMessage: null });
    expect(context.navigateAndWait).not.toHaveBeenCalled();
    flow.disconnect();
  });

  it.each(["navigation", "reconnect"] as const)(
    "consumes an accepted draft before asynchronous cleanup and %s",
    async (next) => {
      const { context, create, flow } = createDraftFixture();
      const sessionKey = "agent:main:dashboard:accepted-draft";
      create.mockResolvedValue({
        key: sessionKey,
        initialRun: { status: "started", runId: "accepted-draft-run" },
      });
      vi.mocked(context.navigateAndWait).mockImplementation(async () => {
        throw new Error("Chat route failed to load");
      });
      let finishCleanup!: () => void;
      const cleanup = vi
        .spyOn(flow.draftPersistence, "clearSubmittedDraft")
        .mockImplementation((_submitted, consume) => {
          consume?.();
          return new Promise<void>((resolve) => {
            finishCleanup = resolve;
          });
        });
      flow.setMessage("  @Alex keep the accepted prompt  ", [
        { profileId: "profile-alex", start: 2, end: 7 },
      ]);
      stubObjectUrls("blob:accepted-note");
      const attachment = registerTextPayload("accepted-note");
      flow.attachmentDraft.replace([attachment]);

      const submission = flow.submit();
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
      const consumed = composerState(flow);
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      if (next === "reconnect") {
        flow.invalidate("gateway-changed");
      }
      finishCleanup();
      await submission;

      expect(consumed).toEqual(["", [], []]);
      expect(composerState(flow)).toEqual(["", [], []]);
      expect(create).toHaveBeenCalledOnce();
      expect(context.navigateAndWait).toHaveBeenCalledTimes(next === "navigation" ? 1 : 0);
      const retained = context.chatSubmissions.readInitial(
        sessionKey,
        context.gateway.snapshot.client,
      );
      expect(retained?.message?.content).toContainEqual({
        type: "text",
        text: "@Alex keep the accepted prompt",
      });
      expect(retained?.message?.content).toContainEqual({
        type: "attachment",
        attachment: {
          url: `data:text/plain;base64,${btoa("accepted-note")}`,
          kind: "document",
          label: "accepted-note.txt",
          mimeType: "text/plain",
        },
      });
      expect(retained?.message?.["__openclaw"]).toMatchObject({
        humanMentions: [{ profileId: "profile-alex", start: 0, end: 5 }],
      });
      expect(getChatAttachmentDataUrl(attachment)).toBeNull();
      if (next === "reconnect") {
        cleanup.mockRestore();
        flow.synchronizeSubmission();
        expect(flow.submissionOutcomeUnknown).toBeNull();
        flow.setMessage("a new prompt after reconnect");
        expect(flow.canSubmit()).toBe(true);
        create.mockResolvedValue({
          key: "agent:main:dashboard:next-draft",
          initialRun: { status: "started", runId: "next-draft-run" },
        });
        vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
        await flow.submit();
        expect(create.mock.calls.map(([params]) => params?.message)).toEqual([
          "@Alex keep the accepted prompt",
          "a new prompt after reconnect",
        ]);
        expect(flow.message).toBe("");
      }
    },
  );
  it("replays a frozen background create without inheriting mutable draft state", async () => {
    const takePreparedTitle = vi.fn(() => "Original prepared title");
    const { context, create, flow, place } = createDraftFixture({
      takePreparedTitle,
      ...placementAccess,
    });
    const original = createDeferred<SessionCreateOutcome>();
    const result = { key: "agent:main:direct-resumed", initialRun: { status: "idle" as const } };
    create.mockReturnValueOnce(original.promise).mockResolvedValueOnce(result);
    vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
    flow.setMessage("@Alex keep the original direct request", [
      { profileId: "profile-original", start: 0, end: 5 },
    ]);

    const initialSubmission = flow.submit(undefined, true);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const originalParams = create.mock.calls[0]?.[0];
    expect(originalParams).toMatchObject({
      displayName: "Original prepared title",
      mentions: [{ profileId: "profile-original", start: 0, end: 5 }],
    });
    flow.invalidate("gateway-changed");
    takePreparedTitle.mockReturnValue("Replacement prepared title");
    flow.setMessage("@Alex a different draft", [
      { profileId: "profile-replacement", start: 0, end: 5 },
    ]);
    place.applyPendingPlacement({ agentId: "main", profileId: "new-cloud-discovery" });
    expect(flow.canSubmit()).toBe(false);
    expect(flow.submitting).toBe(true);

    flow.synchronizeSubmission();
    expect(flow.pendingMessage?.["__openclaw"].humanMentions).toEqual([
      { profileId: "profile-original", start: 0, end: 5 },
    ]);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[0]).toEqual(originalParams);
    expect(flow.pendingPlacement.sessionKey).toBe("");
    original.resolve(result);
    await initialSubmission;
    await vi.waitFor(() => expect(flow.submitting).toBe(false));
    expect(context.navigateAndWait).not.toHaveBeenCalled();
    expect(context.gateway.setSessionKey).not.toHaveBeenCalled();
  });

  it.each(["lost authority", "expired retry"])(
    "unlocks an interrupted create after %s",
    async (reason) => {
      const expired = reason === "expired retry";
      const clock = expired ? vi.spyOn(Date, "now").mockReturnValue(1_000) : undefined;
      const { context, create, flow } = createDraftFixture();
      const original = createDeferred<SessionCreateOutcome>();
      create.mockReturnValueOnce(original.promise);
      flow.setMessage(
        expired ? "the original outcome is unknown" : "do not replay without authority",
      );
      const initialSubmission = flow.submit();
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      flow.invalidate("gateway-changed");
      if (expired) {
        clock?.mockReturnValue(1_000 + SESSION_CREATE_RETRY_WINDOW_MS);
      } else if (context.gateway.snapshot.hello?.features) {
        context.gateway.snapshot.hello.features.methods = [];
      }

      flow.synchronizeSubmission();

      if (expired) {
        expect(flow.submissionOutcomeUnknown).toBe("gateway-changed");
        expect(flow.canSubmit()).toBe(false);
      } else {
        expect(flow.error).toBeTruthy();
      }
      expect(flow.submitting).toBe(false);
      expect(create).toHaveBeenCalledOnce();
      original.resolve({ key: "agent:main:old", initialRun: { status: "idle" } });
      await initialSubmission;
      clock?.mockRestore();
    },
  );

  it("makes attachment restore release only displaced payload ids", () => {
    const revokeObjectURL = stubObjectUrls("blob:shared", "blob:displaced", "blob:incoming");
    const { flow } = createDraftFixture();
    const noteUserMutation = vi.spyOn(flow.draftPersistence, "noteUserMutation");
    const shared = registerTextPayload("shared");
    const displaced = registerTextPayload("displaced");
    const incoming = registerTextPayload("incoming");
    expect([shared, displaced, incoming].map(getChatAttachmentPreviewUrl)).toEqual([
      "blob:shared",
      "blob:displaced",
      "blob:incoming",
    ]);
    flow.attachmentDraft.replace([shared, displaced]);
    noteUserMutation.mockClear();
    revokeObjectURL.mockClear();

    flow.attachmentDraft.restore([shared, incoming]);

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:displaced");
    expect(getChatAttachmentDataUrl(shared)).not.toBeNull();
    expect(getChatAttachmentDataUrl(incoming)).not.toBeNull();
    expect(getChatAttachmentDataUrl(displaced)).toBeNull();
    expect(noteUserMutation).not.toHaveBeenCalled();
    flow.attachmentDraft.reset();
  });

  it("releases the displaced payload and renders placement recovery once without a user mutation", () => {
    const revokeObjectURL = stubObjectUrls("blob:current-draft");
    const { flow } = createDraftFixture();
    const noteUserMutation = vi.spyOn(flow.draftPersistence, "noteUserMutation");
    const current = registerTextPayload("current");
    expect(getChatAttachmentPreviewUrl(current)).toBe("blob:current-draft");
    flow.attachmentDraft.replace([current]);
    noteUserMutation.mockClear();
    revokeObjectURL.mockClear();
    const message = "@Alex recovered cloud prompt";
    const mentions = [{ profileId: "profile-alex", start: 0, end: 5 }];
    const attachments = [
      {
        type: "file" as const,
        mimeType: "text/plain",
        fileName: "recovered.txt",
        content: "cmVjb3ZlcmVk",
      },
    ];
    expect(
      writeSessionPlacementRecovery({
        sessionKey: "agent:main:dashboard:recovery",
        messageId: "message-recovery",
        message,
        mentions,
        attachments,
        target: { kind: "profile", profileId: "aws" },
        agentId: "main",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "creating",
        createParams: {
          key: "agent:main:dashboard:recovery",
          agentId: "main",
          message: "",
          worktree: true,
        },
      }),
    ).toBe(true);

    flow.restorePendingPlacementRecovery("ws://gateway.example", "principal-a");

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:current-draft");
    expect(getChatAttachmentDataUrl(current)).toBeNull();
    expect(noteUserMutation).not.toHaveBeenCalled();
    expect(flow.message).toBe(message);
    expect(flow.mentions).toEqual(mentions);
    expect(buildChatApiAttachments(flow.attachmentDraft.attachments)).toEqual(attachments);
    flow.attachmentDraft.reset();
  });

  it.each([
    { methods: ["sessions.create"], allowed: false, worktree: false },
    { methods: ["projects.add"], allowed: false, worktree: false },
    { methods: ["projects.add", "sessions.create"], allowed: true, worktree: false },
    { methods: ["sessions.create"], allowed: true, worktree: true },
  ])("checks remote-project access with worktree=$worktree", ({ methods, allowed, worktree }) => {
    const { flow, place } = createDraftFixture({ methods });
    place.selectRemoteProject({ ...REMOTE_PROJECT });
    if (worktree) {
      place.selectWorktree(true);
      flow.setMessage("start in a worktree");
    }

    expect(flow.submissionAccess().allowed).toBe(allowed);
  });

  it.each([
    { message: "keep this prompt", worktree: true },
    { message: "", worktree: true },
    { message: "keep this prompt", worktree: false },
  ])(
    "admits a remote project once with prompt $message (worktree=$worktree)",
    async ({ message, worktree }) => {
      const { context, create, flow, place, request } = createDraftFixture();
      const admission = createDeferred<SessionCreateOutcome>();
      create.mockReturnValueOnce(admission.promise);
      vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
      place.selectRemoteProject(REMOTE_PROJECT);
      place.selectWorktree(worktree);
      flow.setMessage(message);
      flow.attachmentDraft.replace([{ ...noteAttachment, id: "attachment-1" }]);
      const submitted = flow.submit();
      const duplicate = flow.submit();
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          message,
          projectGitUrl: REMOTE_PROJECT.cloneUrl,
          attachments: [expect.objectContaining({ fileName: "note.txt", mimeType: "text/plain" })],
        }),
        backgroundCreateOptions,
      );
      expect(request).not.toHaveBeenCalledWith(
        "projects.add",
        expect.anything(),
        expect.anything(),
      );
      admission.resolve({ key: "agent:main:remote-project", initialRun: { status: "idle" } });
      await Promise.all([submitted, duplicate]);
      expect(create).toHaveBeenCalledOnce();
      expect(context.navigateAndWait).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["navigation", null, null, false],
    ["canonical key", "agent:cloud:dashboard:server-key", null, false],
    ["failed navigation", null, "Placement chat route failed to load", false],
    ["background", "agent:cloud:dashboard:background-placement", null, true],
  ] as const)(
    "hands placement to startup through %s",
    async (_scenario, key, error, background) => {
      const navigation = createDeferred();
      let waits = 0;
      const { context, create, flow, place, request } = createDraftFixture({
        agents: [{ id: "cloud", workspace: "/workspace", workspaceGit: true }],
        ...placementAccess,
        request: async (method) => {
          if (method === "worktrees.branches") {
            return { repositoryStatus: "git", branches: [] };
          }
          if (method === "agent.wait" && ++waits === 1) {
            context.gateway.snapshot.phase = "reconnecting";
            throw new Error("gateway closed");
          }
          return { status: "ok", endedAt: 1 };
        },
      });
      const start = vi.fn<ApplicationContext["placementStartup"]["start"]>();
      context.placementStartup.start = start;
      create.mockImplementation(async (params) => ({
        key: key ?? String(params?.key),
        initialRun: { status: "idle" },
      }));
      const navigate = vi.mocked(context.navigateAndWait).mockImplementation(() => {
        expect(context.gateway.snapshot.sessionKey).toBe(
          start.mock.calls[0]![0].recovery.sessionKey,
        );
        return navigation.promise;
      });
      if (error) {
        navigate.mockRejectedValueOnce(new Error(error));
      }
      context.agentSelection.state.selectedId = "cloud";
      const message = "@Alex keep this cloud task";
      const mentions = [{ profileId: "profile-alex", start: 0, end: 5 }];
      const attachments = [{ fileName: "note.txt", content: "SGk=" }];
      flow.setMessage(message, mentions);
      flow.attachmentDraft.replace([{ ...noteAttachment }]);
      flow.pendingPlacement.stageCreate({
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message,
        mentions,
        attachments,
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        createParams: { agentId: "cloud", message: "", worktree: true },
      });
      flow.pendingPlacement.retryAllowed = true;
      place.applyPendingPlacement({ agentId: "cloud", profileId: "aws", cwd: "/workspace" });
      if (background) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const submission = flow.submit(undefined, background);
      if (!background) {
        await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
        if (!error) {
          expect(flow.submitting).toBe(true);
          navigation.resolve();
          document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
        }
      }
      await submission;
      const recovery = start.mock.calls[0]![0].recovery;
      expect(recovery).toMatchObject({ message, mentions, attachments, phase: "dispatching" });
      expect(flow.pendingPlacement.capture()).toBeNull();
      expect(flow.completedSubmission?.key).toBe(recovery.sessionKey);
      expect(flow.pendingMessage?.content).toContainEqual({ type: "text", text: message });
      expect(composerState(flow)).toEqual(["", [], []]);
      expect(flow).toMatchObject({ submitting: false, error });
      if (background) {
        expect(navigate).not.toHaveBeenCalled();
        expect(context.gateway.setSessionKey).not.toHaveBeenCalled();
        expect(context.agentSelection.set).not.toHaveBeenCalled();
        context.gateway.snapshot.phase = "connected";
        await vi.advanceTimersByTimeAsync(1_000);
        expect(waits).toBe(2);
        expect(request).toHaveBeenCalledWith(
          "agent.wait",
          { runId: recovery.messageId, timeoutMs: 30_000 },
          { timeoutMs: null },
        );
      } else {
        expect(context.agentSelection.set).toHaveBeenCalledWith("cloud");
      }
      if (error) {
        expect(flow.canSubmit()).toBe(true);
        const retry = flow.submit();
        await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
        expect(flow.canSubmit()).toBe(false);
        navigation.resolve();
        document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
        await retry;
        expect(flow.error).toBeNull();
      }
      expect(create).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
    },
  );
});
