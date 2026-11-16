/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
  openRowMenu,
} from "./sessions-page.test-support.ts";

const actions = [
  { action: { kind: "set-icon", icon: "book" }, patch: { icon: "book" } },
  { action: { kind: "set-color", color: "blue" }, patch: { color: "blue" } },
  { action: { kind: "reset-appearance" }, patch: { icon: null, color: null } },
] as const;

afterEach(() => document.body.replaceChildren());

async function fixture(
  scopes = ["operator.sessions.write"],
  sharingRole: GatewaySessionRow["sharingRole"] = "owner",
) {
  const row = {
    key: "agent:main:appearance",
    sessionId: "observed-session",
    kind: "direct",
    sharingRole,
  } satisfies GatewaySessionRow;
  const patch = vi.fn(async () => ({ ok: true as const, path: "", key: row.key, entry: row }));
  const sessions = createSessions({ patch });
  const connection = createGateway();
  connection.emit({ hello: sessionMutationGatewayHello(scopes) });
  const page = await createRenderedPage(
    createContext(connection.gateway, sessions),
    sessionsResult([row], 1),
    "all",
  );
  const menu = await openRowMenu(page, row);
  return { row, patch, page, menu };
}

it.each(actions)(
  "dispatches scoped Sessions menu $action.kind with captured identity",
  async ({ action, patch: expectedPatch }) => {
    const { row, patch, page, menu } = await fixture();
    try {
      const dispatch = menu.onAction;
      page.result = sessionsResult([{ ...row, sessionId: "replacement-session" }], 1);
      dispatch(action);
      await vi.waitFor(() =>
        expect(patch).toHaveBeenCalledExactlyOnceWith(row.key, expectedPatch, {
          agentId: undefined,
          expectedSessionId: row.sessionId,
        }),
      );
      expect(page.error).toBeNull();
    } finally {
      page.remove();
    }
  },
);

it.each([
  { scopes: ["operator.sessions.write"], sharingRole: "viewer" },
  { scopes: ["operator.sessions.read"], sharingRole: "owner" },
] as const)(
  "denies unowned or read-only Sessions appearance ($sharingRole, $scopes)",
  async ({ scopes, sharingRole }) => {
    const { patch, page, menu } = await fixture([...scopes], sharingRole);
    try {
      for (const { action } of actions) {
        menu.onAction(action);
        await vi.waitFor(() => expect(page.error).toBeTruthy());
      }
      expect(patch).not.toHaveBeenCalled();
    } finally {
      page.remove();
    }
  },
);

it("does not enable communication changes for a scoped Sessions writer", async () => {
  const { patch, page, menu } = await fixture();
  try {
    menu.onAction({ kind: "set-communication", communication: { send: "never" } });
    await vi.waitFor(() => expect(page.error).toBeTruthy());
    expect(patch).not.toHaveBeenCalled();
  } finally {
    page.remove();
  }
});
