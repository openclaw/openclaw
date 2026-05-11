import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetActionQueueStoreForTest } from "../../actions/action-queue.js";
import { actionsHandlers } from "./actions.js";

function request(method: string, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  return {
    respond,
    invoke: () =>
      actionsHandlers[method]?.({
        req: { type: "req", id: "1", method, params },
        params,
        client: null,
        isWebchatConnect: () => false,
        context: {} as never,
        respond,
      }),
  };
}

describe("actions gateway methods", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-actions-rpc-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    resetActionQueueStoreForTest();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetActionQueueStoreForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("adds, lists, and resolves assistant-visible actions", async () => {
    const add = request("actions.add", {
      title: "Send the article summary",
      caption: "Queue a BlueBubbles draft for approval.",
      source: "notion",
      kind: "draft",
      priority: "high",
      actionLabel: "Draft message",
    });
    await add.invoke();

    expect(add.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        item: expect.objectContaining({
          title: "Send the article summary",
          source: "notion",
          kind: "draft",
          status: "open",
          actionLabel: "Draft message",
        }),
      }),
      undefined,
    );
    const itemId = (add.respond.mock.calls[0]?.[1] as { item: { id: string } }).item.id;

    const list = request("actions.list", { status: "open", limit: 5 });
    await list.invoke();
    expect(list.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        items: [expect.objectContaining({ id: itemId, title: "Send the article summary" })],
      }),
      undefined,
    );

    const resolve = request("actions.resolve", { id: itemId });
    await resolve.invoke();
    expect(resolve.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        item: expect.objectContaining({ id: itemId, status: "done" }),
      }),
      undefined,
    );
  });

  it("returns invalid request errors for bad action input", async () => {
    const add = request("actions.add", { title: "" });
    await add.invoke();

    expect(add.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "title is required",
      }),
    );
  });
});
