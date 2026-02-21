import { describe, expect, it, vi } from "vitest";
import { openSlackModal, pushSlackModal, updateSlackModal } from "./actions.js";

function createModalClient() {
  return {
    views: {
      open: vi.fn(async () => ({
        view: { id: "V_OPEN", external_id: "ext-open", hash: "h-open" },
      })),
      push: vi.fn(async () => ({
        view: { id: "V_PUSH", external_id: "ext-push", hash: "h-push" },
      })),
      update: vi.fn(async () => ({
        view: { id: "V_UPDATE", external_id: "ext-update", hash: "h-update" },
      })),
    },
  } as const;
}

describe("Slack modal actions", () => {
  it("opens a modal and normalizes the response", async () => {
    const client = createModalClient();
    const view = { type: "modal", callback_id: "openclaw:modal:test", blocks: [] };
    const result = await openSlackModal("1337.42", view, {
      client: client as never,
      token: "xoxb-test",
    });

    expect(client.views.open).toHaveBeenCalledWith({
      trigger_id: "1337.42",
      view,
    });
    expect(result).toEqual({
      id: "V_OPEN",
      externalId: "ext-open",
      hash: "h-open",
    });
  });

  it("pushes a modal and normalizes the response", async () => {
    const client = createModalClient();
    const view = { type: "modal", callback_id: "openclaw:modal:push", blocks: [] };
    const result = await pushSlackModal("1337.99", view, {
      client: client as never,
      token: "xoxb-test",
    });

    expect(client.views.push).toHaveBeenCalledWith({
      trigger_id: "1337.99",
      view,
    });
    expect(result).toEqual({
      id: "V_PUSH",
      externalId: "ext-push",
      hash: "h-push",
    });
  });

  it("updates a modal by viewId", async () => {
    const client = createModalClient();
    const view = { type: "modal", callback_id: "openclaw:modal:update", blocks: [] };
    await updateSlackModal(
      {
        view,
        viewId: "V123",
      },
      { client: client as never, token: "xoxb-test" },
    );

    expect(client.views.update).toHaveBeenCalledWith({
      view,
      view_id: "V123",
    });
  });

  it("updates a modal by externalId with hash", async () => {
    const client = createModalClient();
    const view = { type: "modal", callback_id: "openclaw:modal:update", blocks: [] };
    await updateSlackModal(
      {
        view,
        externalId: "ext-123",
        hash: "hash-123",
      },
      { client: client as never, token: "xoxb-test" },
    );

    expect(client.views.update).toHaveBeenCalledWith({
      view,
      external_id: "ext-123",
      hash: "hash-123",
    });
  });

  it("surfaces openModal provider errors", async () => {
    const client = createModalClient();
    client.views.open.mockRejectedValueOnce(new Error("invalid_trigger"));
    await expect(
      openSlackModal(
        "expired-trigger",
        { type: "modal", callback_id: "openclaw:test", blocks: [] },
        {
          client: client as never,
          token: "xoxb-test",
        },
      ),
    ).rejects.toThrow(/invalid_trigger/i);
  });

  it("surfaces updateModal hash conflict errors", async () => {
    const client = createModalClient();
    client.views.update.mockRejectedValueOnce(new Error("hash_conflict"));
    await expect(
      updateSlackModal(
        {
          view: { type: "modal", callback_id: "openclaw:test", blocks: [] },
          viewId: "V123",
          hash: "stale-hash",
        },
        { client: client as never, token: "xoxb-test" },
      ),
    ).rejects.toThrow(/hash_conflict/i);
  });
});
