import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../types.ts";
import {
  captureSessionToWorkboard,
  createWorkboardCard,
  getWorkboardLifecycle,
  getWorkboardState,
  loadWorkboard,
  moveWorkboardCard,
  saveWorkboardCardDraft,
  startWorkboardCard,
  stopWorkboardCard,
  syncWorkboardLifecycle,
  type WorkboardCard,
} from "./workboard.ts";

function createClient(
  responses: Record<string, unknown> | ((method: string, params: unknown) => unknown),
) {
  const request = vi.fn(async (method: string, params: unknown) =>
    typeof responses === "function" ? responses(method, params) : responses[method],
  );
  return { request };
}

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver");
  }
  return { promise, resolve };
}

const sampleCard: WorkboardCard = {
  id: "card-1",
  title: "Build board",
  status: "todo",
  priority: "normal",
  labels: [],
  position: 1000,
  createdAt: 1,
  updatedAt: 1,
};

const sampleSession: GatewaySessionRow = {
  key: "agent:main:dashboard:1",
  kind: "direct",
  updatedAt: 2,
  displayName: "Dashboard session",
  hasActiveRun: true,
  status: "running",
};

describe("workboard controller", () => {
  it("loads cards through the plugin gateway method", async () => {
    const host = {};
    const client = createClient({
      "workboard.cards.list": { cards: [sampleCard], statuses: ["todo", "done"] },
    });

    await loadWorkboard({ host, client: client as never, force: true });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
    expect(getWorkboardState(host).cards).toEqual([sampleCard]);
  });

  it("creates cards from draft state", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.draftTitle = "Write tests";
    state.draftNotes = "Cover the happy path";
    state.draftSessionKey = "agent:main:dashboard:1";
    const created = {
      ...sampleCard,
      id: "card-2",
      title: "Write tests",
      sessionKey: "agent:main:dashboard:1",
    };
    const client = createClient({ "workboard.cards.create": { card: created } });

    await createWorkboardCard({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.create", {
      title: "Write tests",
      notes: "Cover the happy path",
      status: "todo",
      priority: "normal",
      labels: [],
      agentId: "",
      sessionKey: "agent:main:dashboard:1",
    });
    expect(state.cards[0]).toMatchObject({ id: "card-2", title: "Write tests" });
    expect(state.draftOpen).toBe(false);
    expect(state.draftSessionKey).toBe("");
  });

  it("updates cards from draft state when editing", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.cards = [sampleCard];
    state.draftOpen = true;
    state.editingCardId = sampleCard.id;
    state.draftTitle = "Updated board";
    state.draftNotes = "New notes";
    state.draftStatus = "review";
    state.draftPriority = "high";
    state.draftLabels = "ui, polish";
    state.draftAgentId = "dev";
    state.draftSessionKey = sampleSession.key;
    const updated = {
      ...sampleCard,
      title: "Updated board",
      notes: "New notes",
      status: "review",
      priority: "high",
      labels: ["ui", "polish"],
      agentId: "dev",
      sessionKey: sampleSession.key,
    };
    const client = createClient({ "workboard.cards.update": { card: updated } });

    await saveWorkboardCardDraft({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: {
        title: "Updated board",
        notes: "New notes",
        status: "review",
        priority: "high",
        labels: ["ui", "polish"],
        agentId: "dev",
        sessionKey: sampleSession.key,
      },
    });
    expect(state.cards[0]).toMatchObject({ title: "Updated board", status: "review" });
    expect(state.draftOpen).toBe(false);
    expect(state.editingCardId).toBeNull();
  });

  it("captures existing sessions as linked workboard cards", async () => {
    const host = {};
    const session = {
      ...sampleSession,
      label: "Fix login",
      status: "done",
      hasActiveRun: false,
    } as const;
    const created = {
      ...sampleCard,
      title: "Fix login",
      status: "review",
      sessionKey: sampleSession.key,
    } as const;
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [], statuses: ["todo", "running", "review"] };
      }
      if (method === "chat.history") {
        return {
          messages: [
            { role: "user", content: [{ type: "text", text: "Please investigate login" }] },
            { role: "assistant", content: [{ type: "text", text: "Found the issue." }] },
            { role: "user", content: [{ type: "text", text: "Please fix login" }] },
            { role: "assistant", content: [{ type: "text", text: "Implemented and tested." }] },
          ],
        };
      }
      if (method === "workboard.cards.create") {
        return { card: created };
      }
      return {};
    });

    const card = await captureSessionToWorkboard({ host, client: client as never, session });

    expect(card).toMatchObject({ title: "Fix login", status: "review" });
    expect(client.request).toHaveBeenNthCalledWith(1, "workboard.cards.list", {});
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.history", {
      sessionKey: sampleSession.key,
      limit: 40,
      maxChars: 6000,
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "workboard.cards.create", {
      title: "Fix login",
      notes: [
        `Session: ${sampleSession.key}`,
        "",
        "Recent user prompt: Please fix login",
        "",
        "Latest assistant note: Implemented and tested.",
      ].join("\n"),
      status: "review",
      priority: "normal",
      agentId: "",
      sessionKey: sampleSession.key,
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ sessionKey: sampleSession.key });
  });

  it("does not duplicate existing captured sessions", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const existing = { ...sampleCard, sessionKey: sampleSession.key };
    state.loaded = true;
    state.cards = [existing];
    const client = createClient({});

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toBe(existing);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not start duplicate capture requests while a session is in flight", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.capturingSessionKeys.add(sampleSession.key);
    const client = createClient({});

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toBeNull();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not create capture cards when the duplicate preflight list fails", async () => {
    const host = {};
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        throw new Error("list unavailable");
      }
      return {};
    });

    const card = await captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    expect(card).toBeNull();
    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {});
  });

  it("waits for an in-flight Workboard load before capturing a session", async () => {
    const host = {};
    const list = createDeferred<unknown>();
    const created = { ...sampleCard, sessionKey: sampleSession.key };
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return list.promise;
      }
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "workboard.cards.create") {
        return { card: created };
      }
      return {};
    });

    const loading = loadWorkboard({ host, client: client as never, force: true });
    const captured = captureSessionToWorkboard({
      host,
      client: client as never,
      session: sampleSession,
    });

    await Promise.resolve();
    expect(client.request).toHaveBeenCalledTimes(1);
    list.resolve({ cards: [], statuses: ["todo"] });
    await loading;

    await expect(captured).resolves.toMatchObject({ sessionKey: sampleSession.key });
    expect(client.request).toHaveBeenCalledWith("workboard.cards.create", expect.any(Object));
  });

  it("clamps long session labels before creating captured cards", async () => {
    const host = {};
    const longLabel = "x".repeat(220);
    const client = createClient((method) => {
      if (method === "workboard.cards.list") {
        return { cards: [], statuses: ["todo"] };
      }
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "workboard.cards.create") {
        return { card: { ...sampleCard, title: `${"x".repeat(177)}...` } };
      }
      return {};
    });

    await captureSessionToWorkboard({
      host,
      client: client as never,
      session: { ...sampleSession, label: longLabel },
    });

    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "workboard.cards.create",
      expect.objectContaining({
        title: `${"x".repeat(177)}...`,
      }),
    );
  });

  it("starts a session and links it back to the card", async () => {
    const host = {};
    const running = { ...sampleCard, status: "running", sessionKey: "agent:main:dashboard:1" };
    const client = createClient({
      "sessions.create": { key: "agent:main:dashboard:1", runId: "run-1" },
      "workboard.cards.update": { card: running },
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

    expect(sessionKey).toBe("agent:main:dashboard:1");
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "sessions.create",
      expect.objectContaining({
        label: "Build board (card-1)",
        message: expect.stringContaining("Work on this OpenClaw Workboard card: Build board"),
      }),
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: expect.objectContaining({ status: "running", runId: "run-1" }),
      }),
    );
  });

  it("blocks a card when the initial session run fails to start", async () => {
    const host = {};
    const blocked = { ...sampleCard, status: "blocked", sessionKey: "agent:main:dashboard:1" };
    const client = createClient({
      "sessions.create": {
        key: "agent:main:dashboard:1",
        runStarted: false,
        runError: { message: "provider unavailable" },
      },
      "workboard.cards.update": { card: blocked },
    });

    const sessionKey = await startWorkboardCard({
      host,
      client: client as never,
      card: sampleCard,
    });

    expect(sessionKey).toBe("agent:main:dashboard:1");
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: { status: "blocked", sessionKey: "agent:main:dashboard:1" },
      }),
    );
    expect(getWorkboardState(host).error).toBe("Agent run did not start: provider unavailable");
  });

  it("moves cards through the plugin gateway method", async () => {
    const host = {};
    const moved = { ...sampleCard, status: "blocked", position: 2000 };
    const client = createClient({ "workboard.cards.move": { card: moved } });

    await moveWorkboardCard({
      host,
      client: client as never,
      cardId: "card-1",
      status: "blocked",
      position: 2000,
    });

    expect(getWorkboardState(host).cards[0]).toMatchObject({
      status: "blocked",
      position: 2000,
    });
  });

  it("derives lifecycle state from linked dashboard sessions", () => {
    expect(getWorkboardLifecycle(sampleCard, [sampleSession])).toEqual({
      session: null,
      state: "unlinked",
    });

    const linked = { ...sampleCard, sessionKey: sampleSession.key };
    expect(getWorkboardLifecycle(linked, [sampleSession])).toMatchObject({
      state: "running",
      targetStatus: "running",
    });
    expect(
      getWorkboardLifecycle(linked, [{ ...sampleSession, hasActiveRun: false, status: "done" }]),
    ).toMatchObject({
      state: "succeeded",
      targetStatus: "review",
    });
    expect(
      getWorkboardLifecycle(linked, [{ ...sampleSession, hasActiveRun: false, status: "failed" }]),
    ).toMatchObject({
      state: "failed",
      targetStatus: "blocked",
    });
  });

  it("syncs linked card status from session lifecycle without overriding manual review", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [
      { ...sampleCard, sessionKey: sampleSession.key },
      { ...sampleCard, id: "card-review", status: "review", sessionKey: "session-review" },
    ];
    const client = createClient((method) => {
      if (method === "workboard.cards.update") {
        return { card: { ...sampleCard, status: "running", sessionKey: sampleSession.key } };
      }
      return {};
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [
        sampleSession,
        { ...sampleSession, key: "session-review", status: "failed", hasActiveRun: false },
      ],
    });

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      patch: { status: "running" },
    });
    expect(state.cards.find((card) => card.id === "card-review")?.status).toBe("review");
  });

  it("skips lifecycle writeback for read-only workboard clients", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [{ ...sampleCard, sessionKey: sampleSession.key }];
    const client = createClient(() => {
      throw new Error("write denied");
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [sampleSession],
      canWrite: false,
    });

    expect(client.request).not.toHaveBeenCalled();
    expect(state.error).toBeNull();
  });

  it("resyncs cards manually moved back to an active lifecycle column", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      updatedAt: 1000,
    } as const;
    const completedSession = {
      ...sampleSession,
      hasActiveRun: false,
      status: "done",
      updatedAt: 2000,
    } as const;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient({
      "workboard.cards.update": {
        card: { ...linked, status: "review", updatedAt: 3000 },
      },
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });
    state.cards = [{ ...linked, updatedAt: 4000 }];
    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });

    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failed lifecycle sync for the same card and session state", async () => {
    const host = {};
    const state = getWorkboardState(host);
    const linked = {
      ...sampleCard,
      status: "running",
      sessionKey: sampleSession.key,
      updatedAt: 1000,
    } as const;
    const completedSession = {
      ...sampleSession,
      hasActiveRun: false,
      status: "done",
      updatedAt: 2000,
    } as const;
    state.loaded = true;
    state.cards = [linked];
    const client = createClient(() => {
      throw new Error("write denied");
    });

    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });
    await syncWorkboardLifecycle({
      host,
      client: client as never,
      sessions: [completedSession],
    });

    expect(client.request).toHaveBeenCalledOnce();
    expect(state.error).toBe("write denied");
  });

  it("stops linked sessions and marks cards blocked", async () => {
    const host = {};
    const linked = { ...sampleCard, sessionKey: sampleSession.key, runId: "run-1" };
    const blocked = { ...linked, status: "blocked" };
    const client = createClient({
      "chat.abort": { aborted: true, runIds: ["run-1"] },
      "workboard.cards.update": { card: blocked },
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", {
      sessionKey: sampleSession.key,
      runId: "run-1",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ status: "blocked" });
  });

  it("falls back to the active session abort when the stored run id is stale", async () => {
    const host = {};
    const linked = { ...sampleCard, sessionKey: sampleSession.key, runId: "old-run" };
    const blocked = { ...linked, status: "blocked" };
    const client = createClient((method, params) => {
      if (method === "chat.abort" && (params as { runId?: string }).runId === "old-run") {
        return { aborted: false, runIds: [] };
      }
      if (method === "chat.abort") {
        return { aborted: true, runIds: ["new-run"] };
      }
      return { card: blocked };
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", {
      sessionKey: sampleSession.key,
      runId: "old-run",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: sampleSession.key,
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "workboard.cards.update", {
      id: "card-1",
      patch: { status: "blocked" },
    });
    expect(getWorkboardState(host).cards[0]).toMatchObject({ status: "blocked" });
  });

  it("leaves cards unchanged when stop does not abort an active run", async () => {
    const host = {};
    const linked = { ...sampleCard, sessionKey: sampleSession.key, runId: "stale-run" };
    const state = getWorkboardState(host);
    state.cards = [linked];
    const client = createClient({
      "chat.abort": { aborted: false, runIds: [] },
    });

    await stopWorkboardCard({ host, client: client as never, card: linked });

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", {
      sessionKey: sampleSession.key,
      runId: "stale-run",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: sampleSession.key,
    });
    expect(state.cards).toEqual([linked]);
  });
});
