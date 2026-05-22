import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../types.ts";
import {
  createWorkboardCard,
  getWorkboardLifecycle,
  getWorkboardState,
  loadWorkboard,
  moveWorkboardCard,
  startWorkboardCard,
  stopWorkboardCard,
  syncWorkboardLifecycle,
  type WorkboardCard,
} from "./workboard.ts";

function createClient(responses: Record<string, unknown> | ((method: string) => unknown)) {
  const request = vi.fn(async (method: string) =>
    typeof responses === "function" ? responses(method) : responses[method],
  );
  return { request };
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
      priority: "normal",
      agentId: "",
      sessionKey: "agent:main:dashboard:1",
    });
    expect(state.cards[0]).toMatchObject({ id: "card-2", title: "Write tests" });
    expect(state.draftOpen).toBe(false);
    expect(state.draftSessionKey).toBe("");
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
      2,
      "workboard.cards.update",
      expect.objectContaining({
        id: "card-1",
        patch: expect.objectContaining({ status: "running", runId: "run-1" }),
      }),
    );
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
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.update", {
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

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: sampleSession.key,
    });
    expect(state.cards).toEqual([linked]);
  });
});
