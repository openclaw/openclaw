/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import type * as Durable from "../../lib/chat/composer-draft-store.runtime.ts";
import { reviewPrivateComposerDraft } from "../chat/components/private-composer-recovery-dialog.tsx";
import type * as Composer from "../chat/durable-composer-persistence.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { restoreDraft, retainDraft } from "./draft-navigation-handoff.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";

type StoreReadResult = Awaited<ReturnType<typeof Durable.readDurableComposerDraft>>;

function storedDraft(
  text: string,
  writeId: string,
  revision = 7,
  extra: Partial<Extract<StoreReadResult, { status: "found" }>["draft"]> = {},
): StoreReadResult {
  return { status: "found", draft: { revision, text, attachments: [], writeId, ...extra } };
}

const store = vi.hoisted(() => {
  const pendingReads: Array<(result: StoreReadResult) => void> = [];
  return {
    pendingReads,
    hydrateDurableComposerAttachments: vi.fn<typeof Composer.hydrateDurableComposerAttachments>(),
    readDurableComposerDraft: vi.fn(
      () =>
        new Promise<StoreReadResult>((resolve) => {
          pendingReads.push(resolve);
        }),
    ),
    writeDurableComposerDraft: vi.fn(async () => ({ status: "persisted" as const })),
    retireDurableComposerDraft: vi.fn<typeof Durable.retireDurableComposerDraft>(async () => ({
      status: "persisted" as const,
    })),
    writeDurableComposerSnapshot: vi.fn<typeof Composer.writeDurableComposerSnapshot>(async () => ({
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

// Mock the static helper to refresh the lazily imported store seam. This file's
// isolated UI lane prevents that refresh from perturbing sibling singletons.
vi.mock("../chat/durable-composer-persistence.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Composer>();
  store.hydrateDurableComposerAttachments.mockImplementation(
    actual.hydrateDurableComposerAttachments,
  );
  return {
    ...actual,
    writeDurableComposerSnapshot: store.writeDurableComposerSnapshot,
    hydrateDurableComposerAttachments: store.hydrateDurableComposerAttachments,
  };
});

const writeSnapshot = store.writeDurableComposerSnapshot;
const retireDraft = store.retireDurableComposerDraft;
const hydrateAttachments = store.hydrateDurableComposerAttachments;
type Retirement = { status: "persisted"; revision: number; writeId: string };
type SnapshotResult = Awaited<ReturnType<typeof writeSnapshot>>;
const persisted = { result: { status: "persisted" as const }, payloadUnavailable: false };
const conflict = { result: { status: "conflict" as const }, payloadUnavailable: false };

function expectLastWrite(snapshot: Partial<Parameters<typeof writeSnapshot>[0]>) {
  expect(writeSnapshot).toHaveBeenLastCalledWith(expect.objectContaining(snapshot));
}

function holdWrite() {
  const pending = createDeferred<SnapshotResult>();
  writeSnapshot.mockReturnValueOnce(pending.promise);
  return () => pending.resolve(persisted);
}

function modelSelection(
  flow: DraftSubmissionFlow,
  read: NonNullable<DraftSubmissionFlow["draftPersistence"]["modelSelection"]>["read"],
) {
  const selection = { read, restore: vi.fn(), retire: vi.fn() };
  flow.draftPersistence.modelSelection = selection;
  return selection;
}

async function resolvePendingRead(result: StoreReadResult) {
  // The read is issued behind the store's lazy import; wait for it to land.
  await vi.waitFor(() => expect(store.pendingReads.length).toBeGreaterThan(0));
  store.pendingReads.shift()?.(result);
}

// Drain the restore's promise chain (store load, read, write) in one macrotask.
function settle() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function restore(result: StoreReadResult) {
  await resolvePendingRead(result);
  await settle();
}

function activate(
  flow: DraftSubmissionFlow,
  route: string,
  gatewayUrl = "ws://gateway.test",
  recoveryScope = "recovery-a",
) {
  flow.draftPersistence.setOwner(gatewayUrl, recoveryScope);
  flow.draftPersistence.activateRoute(route);
}

function waitForWrite(snapshot: Partial<Parameters<typeof writeSnapshot>[0]>) {
  return vi.waitFor(() => expectLastWrite(snapshot));
}

// The gateway/place states are untouched by draft persistence and typing paths.
function createFlow(route?: string, active = false) {
  const flow = new DraftSubmissionFlow(
    {} as DraftGatewayState,
    {} as DraftPlaceState,
    () => ({ context: undefined, data: undefined, isConnected: false }),
    { changed: vi.fn(), closeTransientUi: vi.fn() },
  );
  if (route) {
    flow.draftPersistence.setOwner("ws://gateway.test", "recovery-a");
    if (active) {
      flow.draftPersistence.activateRoute(route);
    } else {
      flow.draftPersistence.selectRoute(route);
    }
  }
  return flow;
}

afterEach(() => {
  store.pendingReads.length = 0;
  vi.clearAllMocks();
});

describe("NewSessionDraftPersistence restore race", () => {
  it.each([undefined, "read-only", "guarded", "workspace", "full"] as const)(
    "restores draft-local permission %s and resets it for another draft",
    async (permissionMode) => {
      const flow = createFlow("permission-draft", true);
      try {
        await restore(storedDraft("Saved prompt", "saved", 7, { permissionMode }));
        expect(flow.permissionMode).toBe(permissionMode);
        flow.setMessage("Edited prompt");
        flow.draftPersistence.persistNow();
        await waitForWrite({ text: "Edited prompt", permissionMode });
        flow.resetDraft();
        expect(flow.permissionMode).toBeUndefined();
      } finally {
        flow.disconnect();
      }
    },
  );

  it.each([undefined, "read-only"] as const)(
    "preserves a newer permission choice %s while restoring saved content",
    async (permissionMode) => {
      const flow = createFlow("pending-permission", true);
      try {
        flow.setPermissionMode(permissionMode);
        flow.draftPersistence.persistNow();
        expect(writeSnapshot).not.toHaveBeenCalled();
        await restore(storedDraft("Keep saved content", "saved", 7, { permissionMode: "full" }));
        expect(flow.message).toBe("Keep saved content");
        expect(flow.permissionMode).toBe(permissionMode);
        flow.draftPersistence.persistNow();
        await waitForWrite({ text: "Keep saved content", permissionMode });
      } finally {
        flow.disconnect();
      }
    },
  );

  it("preserves a newer edit when stored attachment hydration succeeds late", async () => {
    const flow = createFlow();
    const hydrationEntered = createDeferred();
    const hydration = createDeferred<[]>();
    const { restore: restoreSelection } = modelSelection(flow, () => undefined);
    store.readDurableComposerDraft.mockResolvedValueOnce(
      storedDraft("@Alex stored draft", "stored", 7, {
        mentions: [{ profileId: "old-alex", start: 0, end: 5 }],
        modelSelection: { agentId: "main", model: "openai/stored", thinkingLevel: "low" },
      }),
    );
    hydrateAttachments.mockImplementationOnce(() => {
      hydrationEntered.resolve();
      return hydration.promise;
    });
    try {
      activate(flow, "agent:main");
      await hydrationEntered.promise;
      const mentions = [{ profileId: "new-alex", start: 0, end: 5 }];
      flow.setMessage("@Alex newer edit", mentions);
      hydration.resolve([]);
      // The restore registered its continuation before this await.
      await hydration.promise;
      expect(flow).toMatchObject({ message: "@Alex newer edit", mentions });
      expect(restoreSelection).not.toHaveBeenCalled();
    } finally {
      hydration.resolve([]);
      await hydration.promise;
      const submitted = flow.draftPersistence.captureSubmission();
      flow.disconnect();
      await Promise.all(submitted.mutation.writes);
    }
  });

  it.each(["pending", "canceled", "read", "attachments"] as const)(
    "reconciles stored content before persisting a model-only edit (%s restore)",
    async (restoration) => {
      const flow = createFlow();
      const selection = { agentId: "main", model: "openai/retry", thinkingLevel: "high" };
      modelSelection(flow, () => selection);
      activate(flow, "failed-restoration", "ws://gateway.example", "principal-a");
      if (restoration !== "pending") {
        flow.draftPersistence.captureSubmission();
      }
      flow.draftPersistence.noteSelectionMutation("model");
      const saved = storedDraft("Keep saved content", "saved", 10);
      if (restoration !== "pending") {
        await restore(saved);
        flow.draftPersistence.persistNow();
        expect(writeSnapshot).not.toHaveBeenCalled();
      }
      if (restoration === "read" || restoration === "attachments") {
        if (restoration === "attachments") {
          hydrateAttachments.mockRejectedValueOnce(new Error("Attachment unavailable"));
        }
        await restore(restoration === "read" ? { status: "storage-failed" } : saved);
        flow.draftPersistence.persistNow();
        expect(writeSnapshot).not.toHaveBeenCalled();
        flow.draftPersistence.noteSelectionMutation("model");
      }
      await resolvePendingRead(saved);
      await vi.waitFor(() => expect(flow.message).toBe("Keep saved content"));
      flow.draftPersistence.persistNow();
      await waitForWrite({ text: "Keep saved content", modelSelection: selection });
      flow.disconnect();
    },
  );

  it("persists a model-only edit after a submission capture fails without consuming the draft", async () => {
    const flow = createFlow();
    let selected = "openai/first";
    modelSelection(flow, () => ({ agentId: "main", model: selected, thinkingLevel: "low" }));
    activate(flow, "failed-submission", "ws://gateway.example", "principal-a");
    await restore({ status: "not-found" });
    flow.setMessage("Still unsent");
    flow.draftPersistence.captureSubmission();
    // A rejected/no-result create keeps this same unsent mutation and text.
    selected = "openai/second";
    flow.draftPersistence.noteSelectionMutation("model");
    flow.draftPersistence.persistNow();
    await waitForWrite({
      text: "Still unsent",
      modelSelection: expect.objectContaining({ model: selected }),
    });
    flow.disconnect();
  });

  it("retires accepted model intent only while the submitted mutation still owns the view", async () => {
    const flow = createFlow();
    const { retire } = modelSelection(flow, () => undefined);
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

  it("saves the captured normal draft after retirement settles on another route", async () => {
    const retirement = createDeferred<Retirement>();
    retireDraft.mockReturnValueOnce(retirement.promise);
    const flow = createFlow("original-route");
    flow.setVisibility("incognito");
    flow.setMessage("private input becoming an ordinary draft");
    flow.setVisibility("normal");
    flow.draftPersistence.selectRoute("other-route");
    flow.setMessage("other route input");
    await vi.waitFor(() => expect(retireDraft).toHaveBeenCalled());
    expect(writeSnapshot).not.toHaveBeenCalled();
    const revision = Date.now() + 1000;
    retirement.resolve({ status: "persisted", revision, writeId: "retired:original" });
    await settle();
    expect(writeSnapshot).toHaveBeenCalledWith(
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
      const first = createDeferred<Retirement>();
      const second = createDeferred<Retirement>();
      retireDraft.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const flow = createFlow("private-route");
      flow.setVisibility("incognito");
      flow.setMessage("must remain private");
      flow.setVisibility("normal");
      flow.draftPersistence.persistNow();
      if (editAgain) {
        flow.setMessage("newer private input");
      }
      flow.setVisibility("incognito");
      await vi.waitFor(() => expect(retireDraft.mock.calls.length).toBeGreaterThanOrEqual(2));
      const revision = Date.now() + 1000;
      first.resolve({ status: "persisted", revision, writeId: "retired:first" });
      await settle();
      // The later retirement is deliberately still pending: CAS cannot fence this interval.
      expect(writeSnapshot).not.toHaveBeenCalled();
      second.resolve({ status: "persisted", revision: revision + 1, writeId: "retired:second" });
      await settle();
      expect(writeSnapshot).not.toHaveBeenCalled();
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
      await restore({ status: "not-found", revision: Date.now() });
    }
    expect(target).toMatchObject({ visibility: "incognito", message: "private incognito draft" });
    expect(writeSnapshot).not.toHaveBeenCalled();
    target.disconnect();
    handoff.dispose();
    expect(canReloadControlUiDocument()).toBe(true);
  });

  it.each(["conflict", "late commit"])("reconciles a handed-off edit after %s", async (outcome) => {
    const route = "pending-handoff";
    const source = createFlow(route, true);
    await restore(storedDraft("original", "original-write"));
    let finishWrite: (() => void) | undefined;
    if (outcome === "conflict") {
      writeSnapshot.mockResolvedValueOnce(conflict);
    } else {
      finishWrite = holdWrite();
    }
    source.setMessage("latest unsent edit");
    const handoff = source.draftPersistence.captureSubmission();
    const revision = writeSnapshot.mock.calls[0]![0].revision;
    source.disconnect();
    const target = createFlow(route);
    const persistence = target.draftPersistence;
    target.restoreMessage("latest unsent edit");
    persistence.adoptHandoff(handoff);
    persistence.activateRoute(route);
    finishWrite?.();
    await settle();
    await restore(
      storedDraft("newer stored draft", "another-tab", outcome === "conflict" ? 8 : revision + 1),
    );
    expect(target.message).toBe(
      outcome === "conflict" ? "latest unsent edit" : "newer stored draft",
    );
    expect(writeSnapshot).toHaveBeenCalledTimes(outcome === "conflict" ? 2 : 1);
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
    await restore(storedDraft("newer stored draft", "newer-stored"));
    expect(flow.message).toBe("newer stored draft");
    flow.disconnect();
    handoff.dispose();
  });

  it("consumes a handed-off draft sent before its durable restore resolves", async () => {
    const source = createFlow("handoff-route", true);
    const stored = storedDraft("handed-off draft", "stored-handoff");
    await restore(stored);
    const handoff = source.draftPersistence.captureSubmission();
    source.disconnect();
    const target = createFlow("handoff-route");
    const persistence = target.draftPersistence;
    target.restoreMessage("handed-off draft");
    persistence.adoptHandoff(handoff);
    persistence.activateRoute("handoff-route");
    const submitted = persistence.captureSubmission();
    await restore(stored);
    const clearing = persistence.clearSubmittedDraft(submitted, () => target.restoreMessage(""));
    await resolvePendingRead(stored);
    await clearing;
    expect(target.message).toBe("");
    expect(writeSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
      text: "",
      expectedWriteId: "stored-handoff",
    });
    persistence.disconnect();
  });

  it.each([false, true])(
    "retires a mutation captured during conflict restore (retry settled: %s)",
    async (settled) => {
      const flow = createFlow("conflict-route");
      const persistence = flow.draftPersistence;
      writeSnapshot.mockResolvedValueOnce(conflict);
      flow.setMessage("submitted retry");
      persistence.persistNow();
      await vi.waitFor(() => expect(store.pendingReads).toHaveLength(1));
      const submitted = persistence.captureSubmission();
      const competing = storedDraft("another draft", "another-writer");
      const clearing = settled ? null : persistence.clearSubmittedDraft(submitted);
      await restore(competing);
      if (settled) {
        expect(writeSnapshot).toHaveBeenCalledTimes(2);
        const retry = writeSnapshot.mock.calls[1]![0];
        const accepted = persistence.clearSubmittedDraft(submitted);
        await resolvePendingRead(storedDraft(retry.text, retry.writeId, retry.revision));
        await accepted;
        expect(writeSnapshot.mock.calls.at(-1)?.[0].text).toBe("");
      } else {
        await resolvePendingRead(competing);
        await clearing;
        await settle();
        expect(writeSnapshot).toHaveBeenCalledTimes(1);
      }
      persistence.disconnect();
    },
  );

  it("settles the captured write before retiring an accepted submission", async () => {
    const flow = createFlow("accepted-route");
    const persistence = flow.draftPersistence;
    const finishWrite = holdWrite();
    flow.setMessage("submitted prompt");
    const submitted = persistence.captureSubmission();
    const clearing = persistence.clearSubmittedDraft(submitted);
    await settle();
    expect(store.pendingReads).toHaveLength(0);
    finishWrite();
    const snapshot = writeSnapshot.mock.calls[0]![0];
    await resolvePendingRead(storedDraft("submitted prompt", snapshot.writeId, snapshot.revision));
    await clearing;
    expect(writeSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
      scope: { scopeKey: "accepted-route" },
      text: "",
      storedAttachments: [],
    });
    persistence.disconnect();
  });

  it.each(["newer text", "missing", "pristine", "recipient"] as const)(
    "reconciles the initial stored draft with the composer (%s)",
    async (state) => {
      const flow = createFlow();
      const mentions = [{ profileId: "new-alex", start: 0, end: 5 }];
      const expectedText =
        state === "pristine" || state === "recipient" ? "@Alex" : "typed before restore";
      if (state !== "pristine") {
        flow.setMessage(expectedText, state === "recipient" ? mentions : undefined);
      }
      activate(flow, "agent:main");
      await restore(
        state === "missing"
          ? { status: "not-found" }
          : storedDraft(
              state === "newer text" ? "stored draft" : "@Alex",
              "w-1",
              7,
              state === "pristine"
                ? { mentions }
                : state === "recipient"
                  ? { mentions: [{ profileId: "old-alex", start: 0, end: 5 }] }
                  : {},
            ),
      );
      expect(flow.message).toBe(expectedText);
      if (state === "pristine" || state === "recipient") {
        expect(flow.mentions).toEqual(mentions);
      }
      if (state !== "pristine") {
        const write = writeSnapshot.mock.calls.at(-1)?.[0];
        expect(write?.text).toBe(expectedText);
        if (state === "newer text") {
          expect(write?.revision).toBeGreaterThan(7);
        } else if (state === "recipient") {
          expect(write).toMatchObject({ text: "@Alex", mentions });
        }
      }
      flow.disconnect();
    },
  );

  it("re-arms restore for the next route once the page resets the draft", async () => {
    const flow = createFlow("agent:route-a", true);
    await restore({ status: "not-found" });
    flow.setMessage("typed on route a");
    // Route switch: the page persists, resets the composer, then activates.
    flow.draftPersistence.persistNow();
    flow.resetDraft();
    flow.draftPersistence.activateRoute("agent:route-b");
    await restore(storedDraft("route b draft", "w-2", 9));
    expect(flow.message).toBe("route b draft");
  });
});
