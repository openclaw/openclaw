import { expect } from "vitest";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";
import { installWorkboardBoardMock } from "./control-ui-workboard-mocks.ts";
import { flushMockTimers, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

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

function installBoard(page: { execute(script: string): void }, cards: (typeof card)[]) {
  const seed = {
    boards: [{ id: "default" }],
    cards,
    tasks: [],
    methodResponses: { "workboard.cards.list": { statuses: ["todo", "done"] } },
  };
  page.execute(createControlUiMockGatewayInitScript());
  page.execute(`(${installWorkboardBoardMock.toString()})(${JSON.stringify(seed)})`);
}

it.for([
  ["move", { status: "done", position: 2000 }],
  ["archive", { metadata: { archivedAt: expect.any(Number) } }],
  ["delete", null],
] as const)(
  "rejects stale %s through the serialized Workboard mock without changing cards or emitting events",
  async ([action, expectedCard], { gatewayPage }) => {
    installBoard(gatewayPage, [card]);
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
    if (expectedCard === null) {
      expect(result).toEqual({ deleted: true });
      expect((await socket.request("deleted", "workboard.cards.list", {})).cards).toEqual([]);
    } else {
      expect(result).toMatchObject({ card: { updatedAt: expect.any(Number), ...expectedCard } });
      expect(result).not.toMatchObject({ card: { updatedAt: card.updatedAt } });
    }
    expect(socket.frames.filter((frame) => frame.type === "event")).toHaveLength(events.length + 1);
  },
);

it("returns link cleanup revisions so the next guarded mock delete can succeed", async ({
  gatewayPage,
}) => {
  const parent = { ...card, id: "parent", title: "Parent" };
  const child = {
    ...parent,
    id: "child",
    metadata: {
      ...parent.metadata,
      links: [{ id: "link", type: "parent", targetCardId: parent.id, createdAt: 1 }],
    },
  };
  gatewayPage.execute("Date.now = () => 10;");
  installBoard(gatewayPage, [parent, child]);
  const socket = gatewayPage.connect();
  await flushMockTimers();
  const deleteCard = (id: string, expectedUpdatedAt: number) =>
    socket.request(id, "workboard.cards.delete", { id, expectedUpdatedAt });
  expect(await deleteCard(parent.id, 10)).toEqual({
    deleted: true,
    referenceUpdates: [{ id: child.id, previousUpdatedAt: 10, updatedAt: 11 }],
  });
  expect((await socket.request("list", "workboard.cards.list", {})).cards).toEqual([
    { ...child, updatedAt: 11, metadata: parent.metadata },
  ]);
  expect(await deleteCard(child.id, 11)).toEqual({ deleted: true });
  expect((await socket.request("empty", "workboard.cards.list", {})).cards).toEqual([]);
});
