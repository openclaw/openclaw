/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { reviewPrivateComposerDraft } from "../chat/components/private-composer-recovery-dialog.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { restoreDraft, retainDraft } from "./draft-navigation-handoff.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";

type StoreReadResult =
  | {
      status: "found";
      draft: {
        revision: number;
        text: string;
        mentions?: readonly HumanMention[];
        modelSelection?: { agentId: string; model: string; thinkingLevel: string };
        attachments: unknown[];
        writeId: string;
      };
    }
  | { status: "not-found"; revision?: number; writeId?: string }
  | { status: "storage-failed" };

const store = vi.hoisted(() => {
  const pendingReads: Array<(result: unknown) => void> = [];
  return {
    pendingReads,
    hydrateDurableComposerAttachments:
      vi.fn<
        typeof import("../chat/durable-composer-persistence.ts").hydrateDurableComposerAttachments
      >(),
    readDurableComposerDraft: vi.fn(
      () =>
        new Promise((resolve) => {
          pendingReads.push(resolve as (result: unknown) => void);
        }),
    ),
    writeDurableComposerDraft: vi.fn(async () => ({ status: "persisted" as const })),
    retireDurableComposerDraft: vi.fn<
      typeof import("../../lib/chat/composer-draft-store.runtime.ts").retireDurableComposerDraft
    >(async () => ({ status: "persisted" as const })),
    writeDurableComposerSnapshot: vi.fn<
      typeof import("../chat/durable-composer-persistence.ts").writeDurableComposerSnapshot
    >(async () => ({
      result: { status: "persisted" as const },
      payloadUnavailable: false,
    })),
  };
});

vi.mock("../../lib/chat/composer-draft-store.runtime.ts", () => ({
  readDurableComposerDraft: store.readDurableComposerDraft,
  writeDurableComposerDraft: store.writeDurableComposerDraft,
  retireDurableComposerDraft: store.retireDurableComposerDraft,
}));

// The store runtime above is only dynamically imported, so a shared module
// graph could reuse a draft-persistence.ts evaluated without the mock.
// Mocking this statically imported helper forces a fresh evaluation and gives
// a deterministic write seam; the file also runs in the isolated ui lane
// (vitest.ui-isolated-paths.mjs) so the re-evaluation cannot perturb sibling
// files' module singletons.
vi.mock("../chat/durable-composer-persistence.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat/durable-composer-persistence.ts")>();
  store.hydrateDurableComposerAttachments.mockImplementation(
    actual.hydrateDurableComposerAttachments,
  );
  return {
    ...actual,
    writeDurableComposerSnapshot: store.writeDurableComposerSnapshot,
    hydrateDurableComposerAttachments: store.hydrateDurableComposerAttachments,
  };
});

async function resolvePendingRead(result: StoreReadResult) {
  // The read is issued behind the store's lazy import; wait for it to land.
  await vi.waitFor(() => {
    if (store.pendingReads.length === 0) {
      throw new Error("no pending durable draft read");
    }
  });
  store.pendingReads.shift()?.(result);
}

// Drain the restore's promise chain (store load, read, write) in one macrotask.
function settle() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// The gateway/place states are untouched by draft persistence and typing paths.
function createFlow() {
  return new DraftSubmissionFlow(
    {} as DraftGatewayState,
    {} as DraftPlaceState,
    () => ({ context: undefined, data: undefined, isConnected: false }),
    { requestUpdate: vi.fn(), closeTransientUi: vi.fn() },
  );
}

afterEach(() => {
  store.pendingReads.length = 0;
  vi.clearAllMocks();
});

describe("NewSessionDraftPersistence restore race", () => {
  it("preserves a newer edit when stored attachment hydration succeeds late", async () => {
    const flow = createFlow();
    const hydrationEntered = createDeferred();
    const hydration = createDeferred<[]>();
    const restoreSelection = vi.fn();
    flow.draftPersistence.modelSelection = {
      read: () => undefined,
      restore: restoreSelection,
      retire: vi.fn(),
    };
    store.readDurableComposerDraft.mockResolvedValueOnce({
      status: "found",
      draft: {
        revision: 7,
        text: "@Alex stored draft",
        mentions: [{ profileId: "old-alex", start: 0, end: 5 }],
        modelSelection: { agentId: "main", model: "openai/stored", thinkingLevel: "low" },
        attachments: [],
        writeId: "stored",
      },
    });
    store.hydrateDurableComposerAttachments.mockImplementationOnce(() => {
      hydrationEntered.resolve();
      return hydration.promise;
    });
    try {
      flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
      flow.draftPersistence.activateRoute("agent:main");
      await hydrationEntered.promise;
      const mentions = [{ profileId: "new-alex", start: 0, end: 5 }];
      flow.setMessage("@Alex newer edit", mentions);
      hydration.resolve([]);
      // The restore registered its continuation before this await.
      await hydration.promise;
      expect(flow.message).toBe("@Alex newer edit");
      expect(flow.mentions).toEqual(mentions);
      expect(restoreSelection).not.toHaveBeenCalled();
    } finally {
      hydration.resolve([]);
      await hydration.promise;
      const submitted = flow.draftPersistence.captureSubmission();
      flow.disconnect();
      await Promise.all(submitted.mutation.writes);
    }
  });

  it.each(["read", "attachments"] as const)(
    "never flushes model-only edits after failed %s restoration",
    async (failure) => {
      const flow = createFlow();
      const selection = { agentId: "main", model: "openai/retry", thinkingLevel: "high" };
      flow.draftPersistence.modelSelection = {
        read: () => selection,
        restore: vi.fn(),
        retire: vi.fn(),
      };
      flow.draftPersistence.setOwner("ws://gateway.example", "principal-a");
      flow.draftPersistence.activateRoute("failed-restoration");
      flow.draftPersistence.captureSubmission();
      flow.draftPersistence.noteModelSelectionMutation();
      const saved = {
        status: "found" as const,
        draft: { revision: 10, text: "Keep saved content", attachments: [], writeId: "saved" },
      };
      await resolvePendingRead(saved);
      if (failure === "attachments") {
        store.hydrateDurableComposerAttachments.mockRejectedValueOnce(
          new Error("Attachment unavailable"),
        );
      }
      await resolvePendingRead(failure === "read" ? { status: "storage-failed" } : saved);
      await settle();
      flow.draftPersistence.persistNow();
      expect(store.writeDurableComposerSnapshot).not.toHaveBeenCalled();
      // A later deliberate retry can rehydrate and commit the retained model intent.
      flow.draftPersistence.noteModelSelectionMutation();
      await resolvePendingRead(saved);
      await vi.waitFor(() => expect(flow.message).toBe("Keep saved content"));
      flow.draftPersistence.persistNow();
      await vi.waitFor(() =>
        expect(store.writeDurableComposerSnapshot).toHaveBeenLastCalledWith(
          expect.objectContaining({ text: "Keep saved content", modelSelection: selection }),
        ),
      );
      flow.disconnect();
    },
  );

  it("rehydrates a canceled pristine read before persisting a model-only retry", async () => {
    const flow = createFlow();
    const selection = { agentId: "main", model: "openai/retry", thinkingLevel: "high" };
    flow.draftPersistence.modelSelection = {
      read: () => selection,
      restore: vi.fn(),
      retire: vi.fn(),
    };
    flow.draftPersistence.setOwner("ws://gateway.example", "principal-a");
    flow.draftPersistence.activateRoute("canceled-pristine");
    flow.draftPersistence.captureSubmission();
    flow.draftPersistence.noteModelSelectionMutation();
    // The canceled read may publish lineage, but must not authorize writing empty content.
    await resolvePendingRead({
      status: "found",
      draft: { revision: 10, text: "Saved unsent message", attachments: [], writeId: "saved" },
    });
    await settle();
    flow.draftPersistence.persistNow();
    expect(store.writeDurableComposerSnapshot).not.toHaveBeenCalled();
    await resolvePendingRead({
      status: "found",
      draft: { revision: 10, text: "Saved unsent message", attachments: [], writeId: "saved" },
    });
    await vi.waitFor(() => expect(flow.message).toBe("Saved unsent message"));
    flow.draftPersistence.persistNow();
    await vi.waitFor(() =>
      expect(store.writeDurableComposerSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Saved unsent message", modelSelection: selection }),
      ),
    );
    flow.disconnect();
  });

  it("persists a model-only edit after a submission capture fails without consuming the draft", async () => {
    const flow = createFlow();
    let selected = "openai/first";
    flow.draftPersistence.modelSelection = {
      read: () => ({ agentId: "main", model: selected, thinkingLevel: "low" }),
      restore: vi.fn(),
      retire: vi.fn(),
    };
    flow.draftPersistence.setOwner("ws://gateway.example", "principal-a");
    flow.draftPersistence.activateRoute("failed-submission");
    await resolvePendingRead({ status: "not-found" });
    await settle();
    flow.setMessage("Still unsent");
    flow.draftPersistence.captureSubmission();
    // A rejected/no-result create keeps this same unsent mutation and text.
    selected = "openai/second";
    flow.draftPersistence.noteModelSelectionMutation();
    flow.draftPersistence.persistNow();
    await vi.waitFor(() =>
      expect(store.writeDurableComposerSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "Still unsent",
          modelSelection: expect.objectContaining({ model: selected }),
        }),
      ),
    );
    flow.disconnect();
  });

  it("retires accepted model intent only while the submitted mutation still owns the view", async () => {
    const flow = createFlow();
    const retire = vi.fn();
    flow.draftPersistence.modelSelection = { read: () => undefined, restore: vi.fn(), retire };
    flow.setMessage("Submitted draft");
    const accepted = flow.draftPersistence.captureSubmission();
    await flow.draftPersistence.clearSubmittedDraft(accepted);
    expect(retire).toHaveBeenCalledTimes(1);
    const previous = flow.draftPersistence.captureSubmission();
    flow.setMessage("Newer draft");
    await flow.draftPersistence.clearSubmittedDraft(previous);
    expect(retire).toHaveBeenCalledTimes(1);
    flow.disconnect();
  });

  it("merges a model-only edit with a message whose durable restore is still pending", async () => {
    const flow = createFlow();
    const selection = { agentId: "main", model: "openai/other", thinkingLevel: "low" };
    const restoreSelection = vi.fn();
    flow.draftPersistence.modelSelection = {
      read: () => selection,
      restore: restoreSelection,
      retire: vi.fn(),
    };
    flow.draftPersistence.setOwner("ws://gateway.example", "principal-a");
    flow.draftPersistence.activateRoute("model-choice");
    flow.draftPersistence.noteModelSelectionMutation();
    await resolvePendingRead({
      status: "found",
      draft: { revision: 10, text: "Keep this unsent message", attachments: [], writeId: "stored" },
    });
    await vi.waitFor(() => expect(flow.message).toBe("Keep this unsent message"));
    flow.draftPersistence.persistNow();
    await vi.waitFor(() =>
      expect(store.writeDurableComposerSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Keep this unsent message", modelSelection: selection }),
      ),
    );
    flow.disconnect();
  });

  it("saves the captured normal draft after retirement settles on another route", async () => {
    let finishRetirement!: (result: {
      status: "persisted";
      revision: number;
      writeId: string;
    }) => void;
    store.retireDurableComposerDraft.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRetirement = resolve;
        }),
    );
    const flow = createFlow();
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.selectRoute("original-route");
    flow.setVisibility("incognito");
    flow.setMessage("private input becoming an ordinary draft");
    flow.setVisibility("normal");
    flow.draftPersistence.selectRoute("other-route");
    flow.setMessage("other route input");
    await vi.waitFor(() => expect(finishRetirement).toBeTypeOf("function"));
    expect(store.writeDurableComposerSnapshot).not.toHaveBeenCalled();
    const revision = Date.now() + 1000;
    finishRetirement({ status: "persisted", revision, writeId: "retired:original" });
    await settle();
    expect(store.writeDurableComposerSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ scopeKey: "original-route" }),
        text: "private input becoming an ordinary draft",
        expectedRevision: revision,
        expectedWriteId: "retired:original",
      }),
    );
    expect(flow.message).toBe("other route input");
    flow.disconnect();
    await settle();
  });

  it.each([false, true])(
    "revokes a waiting ordinary write before a second retirement settles (newer edit: %s)",
    async (editAgain) => {
      const retirements: Array<
        (result: { status: "persisted"; revision: number; writeId: string }) => void
      > = [];
      const holdRetirement = () =>
        new Promise<{ status: "persisted"; revision: number; writeId: string }>((resolve) => {
          retirements.push(resolve);
        });
      store.retireDurableComposerDraft
        .mockImplementationOnce(holdRetirement)
        .mockImplementationOnce(holdRetirement);
      const flow = createFlow();
      flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
      flow.draftPersistence.selectRoute("private-route");
      flow.setVisibility("incognito");
      flow.setMessage("must remain private");
      flow.setVisibility("normal");
      flow.draftPersistence.persistNow();
      if (editAgain) {
        flow.setMessage("newer private input");
      }
      flow.setVisibility("incognito");
      await vi.waitFor(() => expect(retirements).toHaveLength(2));
      const [finishFirst, finishSecond] = retirements;
      if (!finishFirst || !finishSecond) {
        throw new Error("Both privacy retirements must be pending");
      }
      const revision = Date.now() + 1000;
      finishFirst({ status: "persisted", revision, writeId: "retired:first" });
      await settle();
      // The later retirement is deliberately still pending: CAS cannot fence this interval.
      expect(store.writeDurableComposerSnapshot).not.toHaveBeenCalled();
      finishSecond({ status: "persisted", revision: revision + 1, writeId: "retired:second" });
      await settle();
      expect(store.writeDurableComposerSnapshot).not.toHaveBeenCalled();
      expect(flow.visibility).toBe("incognito");
      flow.disconnect();
    },
  );

  it("keeps an incognito draft private when navigation hands it to a fresh page", async () => {
    const { context, flow: source } = createDraftFixture();
    const handoff = createChatAttachmentHandoff(context.gateway);
    Object.assign(context, { chatAttachmentHandoff: handoff });
    source.draftPersistence.setOwner("ws://gateway.example", "principal-a");
    source.draftPersistence.selectRoute("private-route");
    source.setVisibility("incognito");
    source.setMessage("private incognito draft");
    retainDraft(context, source, "private-route", "private-route");
    source.disconnect();
    expect(canReloadControlUiDocument()).toBe(false);
    const target = createFlow();
    restoreDraft(context, target, "private-route", "");
    expect(canReloadControlUiDocument()).toBe(true);
    await settle();
    if (store.pendingReads.length) {
      await resolvePendingRead({ status: "not-found", revision: Date.now() });
      await settle();
    }
    expect(target.visibility).toBe("incognito");
    expect(target.message).toBe("private incognito draft");
    expect(store.writeDurableComposerSnapshot).not.toHaveBeenCalled();
    target.disconnect();
    handoff.dispose();
    expect(canReloadControlUiDocument()).toBe(true);
  });

  it.each(["conflict", "late commit"])("reconciles a handed-off edit after %s", async (outcome) => {
    const source = createFlow();
    const route = "pending-handoff";
    source.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    source.draftPersistence.activateRoute(route);
    await resolvePendingRead({
      status: "found",
      draft: { revision: 7, text: "original", attachments: [], writeId: "original-write" },
    });
    await settle();
    let finishWrite: (() => void) | undefined;
    if (outcome === "conflict") {
      store.writeDurableComposerSnapshot.mockResolvedValueOnce({
        result: { status: "conflict" },
        payloadUnavailable: false,
      });
    } else {
      store.writeDurableComposerSnapshot.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishWrite = () =>
              resolve({ result: { status: "persisted" }, payloadUnavailable: false });
          }),
      );
    }
    source.setMessage("latest unsent edit");
    const handoff = source.draftPersistence.captureSubmission();
    const revision = store.writeDurableComposerSnapshot.mock.calls[0]![0].revision;
    source.disconnect();
    const target = createFlow();
    const persistence = target.draftPersistence;
    persistence.setOwner("ws://gateway.test", "recovery-a");
    persistence.selectRoute(route);
    target.restoreMessage("latest unsent edit");
    persistence.adoptHandoff(handoff);
    persistence.activateRoute(route);
    finishWrite?.();
    await settle();
    await resolvePendingRead({
      status: "found",
      draft: {
        revision: outcome === "conflict" ? 8 : revision + 1,
        text: "newer stored draft",
        attachments: [],
        writeId: "another-tab",
      },
    });
    await settle();
    expect(target.message).toBe(
      outcome === "conflict" ? "latest unsent edit" : "newer stored draft",
    );
    expect(store.writeDurableComposerSnapshot).toHaveBeenCalledTimes(
      outcome === "conflict" ? 2 : 1,
    );
    persistence.disconnect();
  });

  it("lets durable restoration supersede a stale handoff during initial owner setup", async () => {
    const { context, flow } = createDraftFixture();
    const handoff = createChatAttachmentHandoff(context.gateway);
    Object.assign(context, { chatAttachmentHandoff: handoff });
    handoff.prepare({
      reviewPrivateDraft: reviewPrivateComposerDraft,
      owner: context.gateway.snapshot.client,
      paneId: "new-session-draft",
      scopeKey: "first-owner",
      message: "stale handoff",
      attachments: [],
      fallbacks: {},
    });
    restoreDraft(context, flow, "first-owner", "");
    await resolvePendingRead({
      status: "found",
      draft: {
        revision: 7,
        text: "newer stored draft",
        attachments: [],
        writeId: "newer-stored",
      },
    });
    await settle();
    expect(flow.message).toBe("newer stored draft");
    flow.disconnect();
    handoff.dispose();
  });

  it("consumes a handed-off draft sent before its durable restore resolves", async () => {
    const source = createFlow();
    source.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    source.draftPersistence.activateRoute("handoff-route");
    const stored: StoreReadResult = {
      status: "found",
      draft: {
        revision: 7,
        text: "handed-off draft",
        attachments: [],
        writeId: "stored-handoff",
      },
    };
    await resolvePendingRead(stored);
    await settle();
    const handoff = source.draftPersistence.captureSubmission();
    source.disconnect();
    const target = createFlow();
    const persistence = target.draftPersistence;
    persistence.setOwner("ws://gateway.test", "recovery-a");
    persistence.selectRoute("handoff-route");
    target.restoreMessage("handed-off draft");
    persistence.adoptHandoff(handoff);
    persistence.activateRoute("handoff-route");
    const submitted = persistence.captureSubmission();
    await resolvePendingRead(stored);
    await settle();
    const clearing = persistence.clearSubmittedDraft(submitted, () => target.restoreMessage(""));
    await resolvePendingRead(stored);
    await clearing;
    expect(target.message).toBe("");
    expect(store.writeDurableComposerSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
      text: "",
      expectedWriteId: "stored-handoff",
    });
    persistence.disconnect();
  });

  it.each([false, true])(
    "retires a mutation captured during conflict restore (retry settled: %s)",
    async (settled) => {
      const flow = createFlow();
      const persistence = flow.draftPersistence;
      persistence.setOwner("ws://gateway.test", "recovery-a");
      persistence.selectRoute("conflict-route");
      store.writeDurableComposerSnapshot.mockResolvedValueOnce({
        result: { status: "conflict" },
        payloadUnavailable: false,
      });
      flow.setMessage("submitted retry");
      persistence.persistNow();
      await vi.waitFor(() => expect(store.pendingReads).toHaveLength(1));
      const submitted = persistence.captureSubmission();
      const competing: StoreReadResult = {
        status: "found",
        draft: {
          revision: 7,
          text: "another draft",
          attachments: [],
          writeId: "another-writer",
        },
      };
      const clearing = settled ? null : persistence.clearSubmittedDraft(submitted);
      await resolvePendingRead(competing);
      await settle();
      if (settled) {
        expect(store.writeDurableComposerSnapshot).toHaveBeenCalledTimes(2);
        const retry = store.writeDurableComposerSnapshot.mock.calls[1]![0];
        const accepted = persistence.clearSubmittedDraft(submitted);
        await resolvePendingRead({
          status: "found",
          draft: {
            revision: retry.revision,
            text: retry.text,
            attachments: [],
            writeId: retry.writeId,
          },
        });
        await accepted;
        expect(store.writeDurableComposerSnapshot.mock.calls.at(-1)?.[0].text).toBe("");
      } else {
        await resolvePendingRead(competing);
        await clearing;
        await settle();
        expect(store.writeDurableComposerSnapshot).toHaveBeenCalledTimes(1);
      }
      persistence.disconnect();
    },
  );

  it("settles the captured write before retiring an accepted submission", async () => {
    const flow = createFlow();
    const persistence = flow.draftPersistence;
    persistence.setOwner("ws://gateway.test", "recovery-a");
    persistence.selectRoute("accepted-route");
    let finishWrite!: () => void;
    store.writeDurableComposerSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWrite = () =>
            resolve({ result: { status: "persisted" }, payloadUnavailable: false });
        }),
    );
    flow.setMessage("submitted prompt");
    const submitted = persistence.captureSubmission();
    const clearing = persistence.clearSubmittedDraft(submitted);
    await settle();
    expect(store.pendingReads).toHaveLength(0);
    finishWrite();
    const snapshot = store.writeDurableComposerSnapshot.mock
      .calls[0]![0] as import("../chat/durable-composer-persistence.ts").DurableChatComposerSnapshot;
    await resolvePendingRead({
      status: "found",
      draft: {
        revision: snapshot.revision,
        text: "submitted prompt",
        attachments: [],
        writeId: snapshot.writeId,
      },
    });
    await clearing;
    expect(store.writeDurableComposerSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
      scope: { scopeKey: "accepted-route" },
      text: "",
      storedAttachments: [],
    });
    persistence.disconnect();
  });

  it("never applies a stored draft over text typed before the restore resolves", async () => {
    const flow = createFlow();
    // Reload flow: the composer renders and the user types before the gateway
    // recovery scope arrives, so the route activates after the mutation.
    flow.setMessage("typed before restore");
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:main");
    await resolvePendingRead({
      status: "found",
      draft: { revision: 7, text: "stored draft", attachments: [], writeId: "w-1" },
    });
    await settle();
    expect(flow.message).toBe("typed before restore");
    // The typed text also wins persistence: local-wins writes it above the
    // stored revision instead of leaving the stale draft in place.
    const write = store.writeDurableComposerSnapshot.mock.calls.at(-1)?.[0] as
      | { revision: number; text: string }
      | undefined;
    expect(write?.text).toBe("typed before restore");
    expect(write?.revision).toBeGreaterThan(7);
  });

  it("persists text typed before activation even when no stored draft exists", async () => {
    const flow = createFlow();
    flow.setMessage("typed before restore");
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:main");
    await resolvePendingRead({ status: "not-found" });
    await settle();
    expect(flow.message).toBe("typed before restore");
    const write = store.writeDurableComposerSnapshot.mock.calls.at(-1)?.[0] as
      | { text: string }
      | undefined;
    expect(write?.text).toBe("typed before restore");
  });

  it("restores stored text and selected recipients into a pristine composer", async () => {
    const flow = createFlow();
    const mentions = [{ profileId: "alex", start: 0, end: 5 }];
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:main");
    await resolvePendingRead({
      status: "found",
      draft: { revision: 7, text: "@Alex", mentions, attachments: [], writeId: "w-1" },
    });
    await settle();
    expect(flow.message).toBe("@Alex");
    expect(flow.mentions).toEqual(mentions);
  });

  it("preserves a same-name recipient selected before stored draft restoration completes", async () => {
    const flow = createFlow();
    const mentions = [{ profileId: "new-alex", start: 0, end: 5 }];
    flow.setMessage("@Alex", mentions);
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:main");
    await resolvePendingRead({
      status: "found",
      draft: {
        revision: 7,
        text: "@Alex",
        mentions: [{ profileId: "old-alex", start: 0, end: 5 }],
        attachments: [],
        writeId: "w-1",
      },
    });
    await settle();
    expect(flow.mentions).toEqual(mentions);
    expect(store.writeDurableComposerSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
      text: "@Alex",
      mentions,
    });
  });

  it("re-arms restore for the next route once the page resets the draft", async () => {
    const flow = createFlow();
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    flow.draftPersistence.activateRoute("agent:route-a");
    await resolvePendingRead({ status: "not-found" });
    await settle();
    flow.setMessage("typed on route a");
    // Route switch: the page persists, resets the composer, then activates.
    flow.draftPersistence.persistNow();
    flow.resetDraft();
    flow.draftPersistence.activateRoute("agent:route-b");
    await resolvePendingRead({
      status: "found",
      draft: { revision: 9, text: "route b draft", attachments: [], writeId: "w-2" },
    });
    await settle();
    expect(flow.message).toBe("route b draft");
  });
});
