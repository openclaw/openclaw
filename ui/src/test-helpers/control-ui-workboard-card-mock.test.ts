/* @vitest-environment jsdom */
import { expect } from "vitest";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";
import { installWorkboardBoardMock } from "./control-ui-workboard-mocks.ts";
import { mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

it("persists guarded position updates and rejects stale card edits without changing the mock", async ({
  gatewayPage,
}) => {
  const initial = {
    id: "first",
    title: "First card",
    status: "todo",
    priority: "normal",
    labels: [],
    position: 1000,
    createdAt: 1,
    updatedAt: 1,
    metadata: { automation: { boardId: "default" } },
  };
  const seed = {
    boards: [{ id: "default" }],
    cards: [initial, { ...initial, id: "second", title: "Second card", position: 2000 }],
    tasks: [],
    methodResponses: { "workboard.cards.list": { statuses: ["todo", "done"] } },
  };
  gatewayPage.execute("Date.now = () => 1;");
  gatewayPage.execute(createControlUiMockGatewayInitScript());
  gatewayPage.execute(`(${installWorkboardBoardMock.toString()})(${JSON.stringify(seed)})`);
  const socket = gatewayPage.connect();
  const updated = await socket.request("reorder", "workboard.cards.update", {
    id: initial.id,
    expectedUpdatedAt: initial.updatedAt,
    patch: { position: 3000 },
  });
  expect(updated).toMatchObject({
    card: { id: "first", position: 3000, status: "todo", updatedAt: 2 },
  });
  const listed = await socket.request("ordered", "workboard.cards.list", {});
  expect(listed.cards).toMatchObject([{ id: "second" }, { id: "first", position: 3000 }]);
  const eventsBeforeConflict = socket.frames.filter((frame) => frame.type === "event");

  await socket.request("stale", "workboard.cards.update", {
    id: initial.id,
    expectedUpdatedAt: initial.updatedAt,
    patch: { position: 0, title: "Stale overwrite" },
  });
  expect(socket.frames.find((frame) => frame.id === "stale")).toMatchObject({
    type: "res",
    ok: false,
    error: {
      code: "workboard_conflict",
      message: "Card changed while you were editing. Review the latest values and retry.",
      details: { type: "workboard_card_conflict", card: updated.card },
    },
  });
  expect(socket.frames.filter((frame) => frame.type === "event")).toEqual(eventsBeforeConflict);
  expect(await socket.request("unchanged", "workboard.cards.list", {})).toEqual(listed);

  const moved = await socket.request("move", "workboard.cards.move", {
    id: initial.id,
    status: "done",
  });
  expect(moved).toMatchObject({ card: { id: "first", status: "done", updatedAt: 3 } });
  const eventsBeforeMoveConflict = socket.frames.filter((frame) => frame.type === "event");
  await socket.request("stale-after-move", "workboard.cards.update", {
    id: initial.id,
    expectedUpdatedAt: 2,
    patch: { position: 0 },
  });
  expect(socket.frames.find((frame) => frame.id === "stale-after-move")).toMatchObject({
    ok: false,
    error: {
      code: "workboard_conflict",
      details: { type: "workboard_card_conflict", card: moved.card },
    },
  });
  expect(socket.frames.filter((frame) => frame.type === "event")).toEqual(eventsBeforeMoveConflict);

  expect(
    await socket.request("unguarded", "workboard.cards.update", {
      id: initial.id,
      patch: { notes: "Updated without a version guard" },
    }),
  ).toMatchObject({
    card: {
      id: "first",
      position: 3000,
      status: "done",
      updatedAt: 4,
      notes: "Updated without a version guard",
    },
  });
});
