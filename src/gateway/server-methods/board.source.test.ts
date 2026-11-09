import { expect, it, vi } from "vitest";
import type { BoardWidgetSourceResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestBoardStore } from "../../boards/board-store.test-support.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-method-policy.js";
import { createBoardHarness } from "./board.test-support.js";

const target = { sessionKey: "agent:main:lobby", agentId: "main" };
const otherTarget = { sessionKey: "agent:main:other", agentId: "main" };

async function fixture(html: string) {
  const store = createTestBoardStore();
  const saved = await store.putWidget({
    ...target,
    name: "scene",
    content: { kind: "html", html },
  });
  const harness = createBoardHarness(undefined, undefined, store);
  const read = async (params: Record<string, unknown> = {}) => {
    const response = await harness.invoke("board.widget.source", {
      ...target,
      name: "scene",
      ...params,
    });
    expect(response.mock.calls[0]?.[0]).toBe(true);
    return response.mock.calls[0]?.[1] as BoardWidgetSourceResult;
  };
  return { ...harness, read, saved };
}

it("reads persisted HTML as inert source without minting view capabilities or changing the board", async () => {
  const html =
    '<script>globalThis.__boardSourceExecuted = true; throw new Error("must not run");</script><p>🌊</p>';
  const { read, store, saved, broadcast } = await fixture(html);
  const result = await read();
  expect(result).toMatchObject({
    sessionKey: target.sessionKey,
    name: "scene",
    revision: 1,
    html,
    offset: 0,
    totalLength: html.length,
  });
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(result).not.toHaveProperty("nextOffset");
  expect(result).not.toHaveProperty("viewTicket");
  expect(result).not.toHaveProperty("frameUrl");
  expect(Object.hasOwn(globalThis, "__boardSourceExecuted")).toBe(false);
  expect(await store.getSnapshot(target)).toMatchObject({ revision: saved.revision });
  expect(broadcast).not.toHaveBeenCalled();
  expect(resolveCoreOperatorGatewayMethodScope("board.widget.source")).toBe("operator.read");
});

it("pages Unicode source and refuses to mix revisions", async () => {
  const html = "a🌊b";
  const { read, invoke, store } = await fixture(html);
  const first = await read({ limit: 2 });
  expect(first.html).toBe("a🌊");
  expect(first.nextOffset).toBe(3);
  const last = await read({ offset: first.nextOffset, expectedRevision: first.revision, limit: 1 });
  expect(first.html + last.html).toBe(html);
  expect(last).not.toHaveProperty("nextOffset");
  const missingRevision = await invoke("board.widget.source", {
    ...target,
    name: "scene",
    offset: 3,
  });
  expect(missingRevision.mock.calls[0]).toMatchObject([
    false,
    undefined,
    { code: "INVALID_REQUEST" },
  ]);
  await store.putWidget({ ...target, name: "scene", content: { kind: "html", html: "changed" } });
  const changed = await invoke("board.widget.source", {
    ...target,
    name: "scene",
    expectedRevision: 1,
    offset: 3,
  });
  expect(changed.mock.calls[0]).toMatchObject([
    false,
    undefined,
    { message: expect.stringContaining("revision changed") },
  ]);
});

it("requires the exact session and an existing HTML widget", async () => {
  const { invoke, store } = await fixture("private scene");
  await store.putWidget({
    ...target,
    name: "report",
    content: {
      kind: "plugin",
      pluginKind: "session:report",
      props: { blocks: [{ type: "text", text: "Native report" }] },
    },
  });
  for (const params of [
    { ...otherTarget, name: "scene" },
    { ...target, name: "missing" },
    { ...target, name: "report" },
  ]) {
    const result = await invoke("board.widget.source", params);
    expect(result.mock.calls[0]).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
    expect(JSON.stringify(result.mock.calls)).not.toContain("private scene");
  }
  await store.putWidget({
    ...otherTarget,
    name: "scene",
    content: { kind: "html", html: "other scene" },
  });
  const result = await invoke("board.widget.source", { ...otherTarget, name: "scene" });
  expect(result.mock.calls[0]?.[1]).toMatchObject({
    sessionKey: otherTarget.sessionKey,
    html: "other scene",
  });
});

it("refuses publication when request authority retires during the source read", async () => {
  const { invoke, store, context } = await fixture("private scene");
  const entered = createDeferred();
  const release = createDeferred();
  const original = store.useWidgetDocument.bind(store);
  vi.spyOn(store, "useWidgetDocument").mockImplementationOnce(async (...args) => {
    const source = await original(...args);
    entered.resolve();
    await release.promise;
    return source;
  });
  const reading = invoke("board.widget.source", { ...target, name: "scene" });
  await entered.promise;
  context.resolveGatewayContext = () => undefined;
  release.resolve();
  const result = await reading;
  expect(result.mock.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
  expect(JSON.stringify(result.mock.calls)).not.toContain("private scene");
});
