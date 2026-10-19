import { describe, expect, it, vi } from "vitest";
import {
  PROGRESS_CARD_MAX_STEPS,
  PROGRESS_CARD_MAX_UTF8_BYTES,
  type ProgressCard,
  type ProgressCardStep,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ProgressCardStore } from "../../session-cards/progress-card-store.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createProgressCardHandlers } from "./progress-card.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const defaultSessionKey = "agent:main:main";
function expectCard(respond: ReturnType<typeof vi.fn>, card: unknown) {
  expect(respond).toHaveBeenCalledWith(true, { card }, undefined);
}
function expectError(respond: ReturnType<typeof vi.fn>, message: string, code = "INVALID_REQUEST") {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining(message), code }),
  );
}
function expectBroadcast(broadcast: ReturnType<typeof vi.fn>, revision: number | null) {
  expect(broadcast).toHaveBeenCalledWith(
    "progressCard.changed",
    { sessionKey: defaultSessionKey, revision },
    { sessionKeys: [defaultSessionKey], agentId: "main" },
  );
}

function createHarness() {
  const cards = new Map<string, ProgressCard>();
  const get = vi.fn<ProgressCardStore["get"]>(async (sessionKey) => cards.get(sessionKey) ?? null);
  const put = vi.fn<ProgressCardStore["put"]>(async (sessionKey, input) => {
    const current = cards.get(sessionKey);
    if (!input.markdown && !input.steps?.length) {
      if (input.expectedRevision !== undefined && current?.revision !== input.expectedRevision) {
        return { card: current ?? null };
      }
      cards.delete(sessionKey);
      return { card: null };
    }
    const card = {
      sessionKey,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      ...(input.markdown ? { markdown: input.markdown } : {}),
      ...(input.steps ? { steps: input.steps } : {}),
    };
    cards.set(sessionKey, card);
    return { card };
  });
  const handlers = createProgressCardHandlers({ get, put });
  const broadcast = vi.fn();
  const invoke = async (
    operation: "get" | "put",
    params: Record<string, unknown> = {},
    respond = vi.fn<RespondFn>(),
  ) => {
    await handlers[`progressCard.${operation}`]!({
      params: { sessionKey: defaultSessionKey, ...params },
      respond,
      context: {
        broadcast,
        getRuntimeConfig: () => ({ agents: { entries: { main: {}, work: {} } } }),
      } as unknown as GatewayRequestContext,
    } as never);
    return respond;
  };
  return { broadcast, invoke, get, put };
}

describe("progress card gateway methods", () => {
  it.each(["get", "put"] as const)(
    "reports rejected %s without publishing or retrying",
    async (operation) => {
      const harness = createHarness();
      const release = createDeferredCore<never>();
      harness[operation].mockImplementationOnce(() => release.promise);
      const respond = vi.fn<RespondFn>();
      const pending = harness.invoke(operation, {}, respond);
      release.reject(new Error("storage unavailable"));
      await pending;
      expectError(respond, "storage unavailable", "UNAVAILABLE");
      expect(respond).toHaveBeenCalledOnce();
      expect(harness.broadcast).not.toHaveBeenCalled();
      expect(harness[operation]).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { agentId: "missing", message: "Unknown agent id" },
    { agentId: "bad owner", message: "Unknown agent id" },
    { agentId: "work", message: 'does not match session key agent "main"' },
  ])("rejects explicit owner $agentId before accessing cards", async ({ agentId, message }) => {
    const { broadcast, invoke, get, put } = createHarness();
    for (const method of ["get", "put"] as const) {
      expectError(await invoke(method, { agentId }), message, "INVALID_REQUEST");
    }
    expect([get.mock.calls, put.mock.calls, broadcast.mock.calls]).toEqual([[], [], []]);
  });

  it("roundtrips markdown and steps, strips invisible Unicode, and broadcasts the revision", async () => {
    const { broadcast, invoke } = createHarness();
    const plan = [
      { step: "Inspect\u200b", status: "completed" },
      { step: "Patch\u202e", status: "in_progress" },
    ];
    const expectedSteps: ProgressCardStep[] = [
      { step: "Inspect", status: "completed" },
      { step: "Patch", status: "in_progress" },
    ];
    const put = await invoke("put", { markdown: "A\u200bB\u202eC", plan });
    const expected = expect.objectContaining({
      markdown: "ABC",
      steps: expectedSteps,
      revision: 1,
    });
    expectCard(put, expected);
    expectCard(await invoke("get"), expected);
    expectBroadcast(broadcast, 1);
  });

  it.each([
    {
      name: "oversized markdown",
      payload: { markdown: "é".repeat(PROGRESS_CARD_MAX_UTF8_BYTES / 2 + 1) },
      message: `${PROGRESS_CARD_MAX_UTF8_BYTES} UTF-8 bytes`,
    },
    {
      name: "too many steps",
      payload: {
        plan: Array.from({ length: PROGRESS_CARD_MAX_STEPS + 1 }, (_, index) => ({
          step: `Step ${index}`,
          status: "pending",
        })),
      },
      message: `more than ${PROGRESS_CARD_MAX_STEPS} items`,
    },
  ])("rejects $name without broadcasting", async ({ payload, message }) => {
    const { broadcast, invoke } = createHarness();
    expectError(await invoke("put", payload), message);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("dismisses only the matching completed revision", async () => {
    const { broadcast, invoke } = createHarness();
    await invoke("put", { plan: [{ step: "Done", status: "completed" }] });
    broadcast.mockClear();

    const stale = await invoke("put", { expectedRevision: 2 });
    const dismissed = await invoke("put", { expectedRevision: 1 });
    expectCard(stale, expect.objectContaining({ revision: 1 }));
    expectCard(dismissed, null);
    expect(broadcast).toHaveBeenCalledOnce();
    expectBroadcast(broadcast, null);
  });
});
