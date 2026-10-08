import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createParticipationTestRuntime,
  createTestRuntime,
} from "./session-runtime.test-support.js";
import type { MeetingTranscriptSnapshot } from "./session-types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MeetingSessionRuntime participation ownership", () => {
  it("revokes participation as soon as leave starts, while an admitted claim is awaiting storage", async () => {
    const { runtime, store, execute } = createParticipationTestRuntime();
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    const { promise: pending, resolve: release } = createDeferredCore();
    const { promise: entered, resolve: claimed } = createDeferredCore();
    const register = store.registerIfAbsent;
    store.registerIfAbsent = async (...args) => {
      claimed();
      await pending;
      return await register(...args);
    };
    const action = runtime.participate(session.id, {
      requestId: "raise",
      action: { type: "hand.set", raised: true },
    });
    await entered;
    const leaving = runtime.leave(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({
      active: false,
      capabilities: [],
    });
    release();
    expect(await action).toMatchObject({ status: "rejected" });
    await leaving;
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not transfer an observed source to a replacement browser tab", async () => {
    const { runtime, execute } = createParticipationTestRuntime();
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    const sourceId = runtime.observeParticipationSource(session.id, {
      id: "message",
      epoch: "page",
      revision: "1",
      kind: "chat",
      text: "Raise your hand",
      finalized: true,
    });
    expect(sourceId).toBeTruthy();
    session.browser!.tab = { targetId: "replacement-tab", openedByPlugin: false };
    expect(runtime.inspectParticipationSource(session.id, sourceId!)).toBeUndefined();
    expect(
      await runtime.participate(session.id, {
        requestId: "raise",
        sourceId,
        action: { type: "hand.set", raised: true },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(execute).not.toHaveBeenCalled();
    await runtime.leave(session.id);
  });

  it.each([
    { participation: true, change: "tab" },
    ...["tab", "id", "url", "state", "transport", "node"].map((change) => ({
      participation: false,
      change,
    })),
  ])(
    "revalidates $change during caption capture (participation: $participation)",
    async ({ participation, change }) => {
      const pending = createDeferredCore<MeetingTranscriptSnapshot>();
      const entered = createDeferredCore();
      const captureTranscript = vi
        .fn<NonNullable<Parameters<typeof createTestRuntime>[0]["captureTranscript"]>>()
        .mockImplementationOnce(async () => {
          entered.resolve();
          return await pending.promise;
        })
        .mockImplementation(async () => (participation ? undefined : await pending.promise));
      const { runtime } = participation
        ? createParticipationTestRuntime({ captureTranscript, transcribe: true })
        : createTestRuntime({
            transcribe: true,
            captureTranscript,
            joinTransport: async ({ session }) => {
              session.browser = {
                launched: true,
                tab: { targetId: "original-tab", openedByPlugin: false },
              };
              return {};
            },
            releaseBrowserTab: async () => true,
          });
      const url = "https://meeting.example/room";
      const { session } = await runtime.join({ url, agentId: "operator" });
      const sessionId = session.id;
      const reading = runtime.transcript(sessionId);
      await entered.promise;
      session.browser!.tab!.targetId = "recovered-tab";
      session.id = change === "id" ? "another-session" : session.id;
      session.url = change === "url" ? `${url}/other` : url;
      session.state = change === "state" ? "ended" : session.state;
      session.transport = change === "transport" ? "chrome-node" : session.transport;
      session.browser!.nodeId = change === "node" ? "another-node" : undefined;
      pending.resolve({
        droppedLines: 0,
        epoch: "old-page",
        lines: [
          {
            text: "Recovered caption",
            ...(participation
              ? {
                  source: {
                    id: "old-caption",
                    epoch: "old-page",
                    revision: "2",
                    finalized: true,
                    ownEcho: false,
                  },
                }
              : {}),
          },
        ],
      });
      if (!participation && change === "tab") {
        await expect(reading).resolves.toMatchObject({ lines: [{ text: "Recovered caption" }] });
      } else {
        await expect(reading).rejects.toThrow("no longer owns the captured browser tab and route");
      }
      if (participation) {
        expect(runtime.participationContext(sessionId)).toMatchObject({
          sourceOrder: 0,
          sources: [],
        });
      }
      session.id = sessionId;
      await runtime.leave(sessionId);
    },
  );

  it("records a caption's original order before finalization and revokes it on a pending correction", async () => {
    const source = {
      id: "caption-1",
      epoch: "page-1",
      revision: "1",
      finalized: false,
      ownEcho: false,
    };
    const completed = {
      text: "Please share the recap",
      source: { ...source, revision: "2", finalized: true },
    };
    const snapshots: MeetingTranscriptSnapshot[] = [
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [],
        pendingLines: [{ text: "Please share", source }],
      },
      { droppedLines: 0, epoch: "page-1", lines: [completed], pendingLines: [] },
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [completed],
        pendingLines: [{ text: "Please wait", source: { ...source, revision: "3" } }],
      },
    ];
    const { runtime } = createParticipationTestRuntime({
      captureTranscript: async () => snapshots.shift(),
      transcribe: true,
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    await runtime.transcript(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    await runtime.transcript(session.id);
    const context = runtime.participationContext(session.id);
    expect(context).toMatchObject({
      sourceOrder: 1,
      sources: [{ id: "caption-1", kind: "caption", order: 1, finalized: true, ownEcho: false }],
    });
    const sourceId = context.sources[0]?.sourceId;
    expect(sourceId).toBeTruthy();
    await runtime.transcript(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    expect(runtime.inspectParticipationSource(session.id, sourceId!)).toBeUndefined();
    await runtime.leave(session.id);
  });

  it("invalidates caption authority on an empty new epoch without minting a source event", async () => {
    const oldSnapshot: MeetingTranscriptSnapshot = {
      droppedLines: 0,
      epoch: "old-page",
      lines: [
        {
          text: "Please share the recap",
          source: {
            id: "caption-1",
            epoch: "old-page",
            revision: "2",
            finalized: true,
            ownEcho: false,
          },
        },
      ],
    };
    const snapshots: MeetingTranscriptSnapshot[] = [
      oldSnapshot,
      { droppedLines: 0, epoch: "new-page", lines: [], pendingLines: [] },
      oldSnapshot,
    ];
    const { runtime } = createParticipationTestRuntime({
      captureTranscript: async () => snapshots.shift(),
      transcribe: true,
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    await runtime.transcript(session.id);
    const sourceId = runtime.participationContext(session.id).sources[0]?.sourceId;
    expect(sourceId).toBeTruthy();
    await runtime.transcript(session.id);
    expect(runtime.inspectParticipationSource(session.id, sourceId!)).toBeUndefined();
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    await runtime.transcript(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    await runtime.leave(session.id);
  });
});
