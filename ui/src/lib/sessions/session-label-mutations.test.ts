// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const initial: GatewaySessionRow = {
  key: "agent:main:rename-test",
  sessionId: "rename-incarnation",
  kind: "direct",
  updatedAt: 1,
  label: "Original session",
};

function setup() {
  const reply = createDeferred<unknown>();
  const list = createDeferred<ReturnType<typeof sessionsResult>>();
  let reads = 0;
  const client = createTestGatewayClient(async (method) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.patch") {
      return reply.promise;
    }
    if (method === "sessions.list") {
      return ++reads === 1 ? sessionsResult([initial], 1) : list.promise;
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
  return {
    sessions,
    list,
    confirm: (label: string | undefined) =>
      reply.resolve({
        ok: true,
        key: initial.key,
        path: "",
        entry: { ...initial, label, updatedAt: 2 },
      }),
    label: () => sessions.state.result?.sessions[0]?.label,
  };
}

describe("session label mutations", () => {
  it.each(["Renamed session", undefined])(
    "publishes the acknowledged label ahead of a read started before the rename (%s)",
    async (label) => {
      const h = setup();
      try {
        await h.sessions.refresh({ agentId: "main", force: true });
        const reading = h.sessions.refresh({ agentId: "main", force: true });
        const pending = h.sessions.patch(
          initial.key,
          { label: label ?? null },
          { agentId: "main", expectedSessionId: initial.sessionId, deferListRefresh: true },
        );
        h.confirm(label);
        await pending;
        expect(h.label()).toBe(label);
        h.list.resolve(sessionsResult([{ ...initial }], 1));
        await reading;
        expect(h.label()).toBe(label);
      } finally {
        h.sessions.dispose();
      }
    },
  );
});
