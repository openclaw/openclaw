import { expect } from "vitest";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";
import { installWorkboardBoardMock } from "./control-ui-workboard-mocks.ts";
import { flushMockTimers, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

const seed = {
  boards: [{ id: "planning", icon: "rocket", color: "blue" }],
  cards: [],
  tasks: [],
  methodResponses: { "workboard.cards.list": { statuses: ["todo"] } },
};

it("preserves legacy appearance inputs and round-trips explicit reset through the serialized mock", async ({
  gatewayPage,
}) => {
  gatewayPage.execute(createControlUiMockGatewayInitScript());
  gatewayPage.execute(`(${installWorkboardBoardMock.toString()})(${JSON.stringify(seed)});`);
  const { request } = gatewayPage.connect();
  await flushMockTimers();
  for (const [index, value] of [undefined, null, "", "   "].entries()) {
    expect(
      await request(`preserve-${index}`, "workboard.boards.upsert", {
        id: "planning",
        icon: value,
        color: value,
      }),
    ).toMatchObject({ board: { icon: "rocket", color: "blue" } });
  }
  const cleared = await request("reset-icon", "workboard.boards.upsert", {
    id: "planning",
    icon: "replacement",
    clearAppearance: ["icon"],
  });
  expect(cleared.board).toMatchObject({ id: "planning", color: "blue" });
  expect(cleared.board).not.toHaveProperty("icon");
  expect(cleared.board).not.toHaveProperty("clearAppearance");
  await request("reset-color", "workboard.boards.upsert", {
    id: "planning",
    clearAppearance: ["color"],
  });
  const listed = await request("list-reset", "workboard.boards.list", {});
  expect(listed.boards).toHaveLength(1);
  const board = (listed.boards as Array<Record<string, unknown>>)[0];
  expect(board).toMatchObject({ id: "planning" });
  expect(board).not.toHaveProperty("icon");
  expect(board).not.toHaveProperty("color");
  expect(board).not.toHaveProperty("clearAppearance");
});

it("rejects invalid appearance clearing before changing the serialized mock", async ({
  gatewayPage,
}) => {
  gatewayPage.execute(createControlUiMockGatewayInitScript());
  gatewayPage.execute(`(${installWorkboardBoardMock.toString()})(${JSON.stringify(seed)});`);
  const { send, frames, request } = gatewayPage.connect();
  await flushMockTimers();
  for (const [index, clearAppearance] of [null, "icon", ["name"], [null]].entries()) {
    const id = `invalid-reset-${index}`;
    send(id, "workboard.boards.upsert", { id: "planning", icon: "changed", clearAppearance });
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === id)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  }
  expect(frames.filter((frame) => frame.event === "plugin.workboard.changed")).toHaveLength(0);
  expect(await request("list-unchanged", "workboard.boards.list", {})).toMatchObject({
    boards: [{ id: "planning", icon: "rocket", color: "blue" }],
  });
});
