import { expect } from "vitest";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";
import { installWorkboardBoardMock } from "./control-ui-workboard-mocks.ts";
import { flushMockTimers, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

it.for(["move", "archive", "delete"] as const)(
  "rejects stale %s through the serialized Workboard mock without changing cards or emitting events",
  async (action, { gatewayPage }) => {
    const card = {
      id: "card",
      title: "Latest title",
      status: "todo",
      priority: "normal",
      labels: [],
      position: 1000,
      createdAt: 1,
      updatedAt: 10,
      metadata: { automation: { boardId: "default" } },
    };
    const seed = {
      boards: [{ id: "default" }],
      cards: [card],
      tasks: [],
      methodResponses: { "workboard.cards.list": { statuses: ["todo", "done"] } },
    };
    gatewayPage.execute(createControlUiMockGatewayInitScript());
    gatewayPage.execute(`(${installWorkboardBoardMock.toString()})(${JSON.stringify(seed)})`);
    const socket = gatewayPage.connect();
    await flushMockTimers();
    const before = await socket.request("before", "workboard.cards.list", {});
    const events = socket.frames.filter((frame) => frame.type === "event");
    const params = { id: card.id, status: "done", position: 2000, archived: true };
    await socket.request("stale", `workboard.cards.${action}`, { ...params, expectedUpdatedAt: 9 });
    expect(socket.frames.find((frame) => frame.id === "stale")).toMatchObject({
      ok: false,
      error: { code: "workboard_conflict", details: { type: "workboard_card_conflict", card } },
    });
    expect(socket.frames.filter((frame) => frame.type === "event")).toEqual(events);
    expect(await socket.request("unchanged", "workboard.cards.list", {})).toEqual(before);
    const result = await socket.request("current", `workboard.cards.${action}`, {
      ...params,
      expectedUpdatedAt: card.updatedAt,
    });
    if (action === "delete") {
      expect(result).toEqual({ deleted: true });
      expect((await socket.request("deleted", "workboard.cards.list", {})).cards).toEqual([]);
    } else {
      expect(result).toMatchObject({ card: { updatedAt: expect.any(Number) } });
      expect(result).not.toMatchObject({ card: { updatedAt: card.updatedAt } });
      if (action === "move") {
        expect(result).toMatchObject({ card: { status: "done", position: 2000 } });
      } else {
        expect(result).toMatchObject({ card: { metadata: { archivedAt: expect.any(Number) } } });
      }
    }
    expect(socket.frames.filter((frame) => frame.type === "event")).toHaveLength(events.length + 1);
  },
);

it("returns link cleanup revisions so the next guarded mock delete can succeed", async ({
  gatewayPage,
}) => {
  const parent = {
    id: "parent",
    title: "Parent",
    status: "todo",
    priority: "normal",
    labels: [],
    position: 1000,
    createdAt: 1,
    updatedAt: 10,
    metadata: { automation: { boardId: "default" } },
  };
  const child = {
    ...parent,
    id: "child",
    metadata: {
      ...parent.metadata,
      links: [{ id: "link", type: "parent", targetCardId: parent.id, createdAt: 1 }],
    },
  };
  const seed = {
    boards: [{ id: "default" }],
    cards: [parent, child],
    tasks: [],
    methodResponses: { "workboard.cards.list": { statuses: ["todo", "done"] } },
  };
  gatewayPage.execute("Date.now = () => 10;");
  gatewayPage.execute(createControlUiMockGatewayInitScript());
  gatewayPage.execute(`(${installWorkboardBoardMock.toString()})(${JSON.stringify(seed)})`);
  const socket = gatewayPage.connect();
  await flushMockTimers();
  expect(
    await socket.request("parent", "workboard.cards.delete", {
      id: parent.id,
      expectedUpdatedAt: 10,
    }),
  ).toEqual({
    deleted: true,
    referenceUpdates: [{ id: child.id, previousUpdatedAt: 10, updatedAt: 11 }],
  });
  expect((await socket.request("list", "workboard.cards.list", {})).cards).toEqual([
    { ...child, updatedAt: 11, metadata: parent.metadata },
  ]);
  expect(
    await socket.request("child", "workboard.cards.delete", {
      id: child.id,
      expectedUpdatedAt: 11,
    }),
  ).toEqual({ deleted: true });
  expect((await socket.request("empty", "workboard.cards.list", {})).cards).toEqual([]);
});
