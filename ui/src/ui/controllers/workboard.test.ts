import { describe, expect, it, vi } from "vitest";
import {
  createWorkboardCard,
  getWorkboardState,
  loadWorkboard,
  moveWorkboardCard,
  startWorkboardCard,
  type WorkboardCard,
} from "./workboard.ts";

function createClient(responses: Record<string, unknown>) {
  const request = vi.fn(async (method: string) => responses[method]);
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
    const created = { ...sampleCard, id: "card-2", title: "Write tests" };
    const client = createClient({ "workboard.cards.create": { card: created } });

    await createWorkboardCard({ host, client: client as never });

    expect(client.request).toHaveBeenCalledWith("workboard.cards.create", {
      title: "Write tests",
      notes: "Cover the happy path",
      priority: "normal",
      agentId: "",
    });
    expect(state.cards[0]).toMatchObject({ id: "card-2", title: "Write tests" });
    expect(state.draftOpen).toBe(false);
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
});
