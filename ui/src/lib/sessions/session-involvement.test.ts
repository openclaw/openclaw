// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionRequest } from "./hydration-family.test-support.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import { setSessionInvolvement } from "./session-involvement-write.runtime.ts";
import { rosterFixture } from "./session-roster-refresh.test-support.ts";

const row = {
  key: "agent:main:design",
  sessionId: "design",
  kind: "direct" as const,
  updatedAt: 1,
  hiddenFromInvolvingMe: false,
};
const personal = { agentId: "main", involvingMe: true };
function fixture() {
  const hide = createDeferred();
  const show = createDeferred();
  const request = sessionRequest({
    "sessions.list": () => sessionsResult([row]),
    "sessions.setInvolvement": (params) =>
      params && typeof params === "object" && "hidden" in params && params.hidden === true
        ? hide.promise
        : show.promise,
    "sessions.subscribe": () => ({ subscribed: true }),
  });
  const client = createTestGatewayClient(request);
  const h = rosterFixture(client.request.bind(client), { ownerId: "ada" });
  h.watch(personal);
  const set = (hidden: boolean) =>
    h.sessions.setInvolvement(
      { key: row.key, expectedSessionId: row.sessionId, agentId: "main", hidden },
      setSessionInvolvement,
    );
  return {
    ...h,
    set,
    hide,
    show,
    writes: () =>
      request.mock.calls.filter(([method]) => method === "sessions.setInvolvement").length,
  };
}

it("serializes opposite decisions while showing the latest click, then restores the last accepted choice on failure", async () => {
  const h = fixture();
  await h.sessions.refreshList(personal);
  const hiding = h.set(true);
  expect(h.listRows(personal)).toEqual([]);
  const showing = h.set(false);
  expect(h.listRows(personal)).toEqual([row]);
  await vi.waitFor(() => expect(h.writes()).toBe(1));
  h.hide.resolve();
  expect(await hiding).toBe(false);
  expect(h.listRows(personal)).toEqual([row]);
  expect(h.writes()).toBe(2);
  h.show.reject(new Error("Could not change personal visibility"));
  await expect(showing).rejects.toThrow("Could not change personal visibility");
  expect(h.listRows(personal)).toEqual([]);
});

it("does not settle one viewer's Hide into the replacement viewer's list", async () => {
  const h = fixture();
  await h.sessions.refreshList(personal);
  const hiding = h.set(true);
  expect(h.listRows(personal)).toEqual([]);
  await vi.waitFor(() => expect(h.writes()).toBe(1));
  h.update({ selfUser: { id: "bea" } });
  await h.sessions.refreshList(personal);
  h.hide.resolve();
  expect(await hiding).toBe(false);
  expect(h.listRows(personal)).toEqual([row]);
});
