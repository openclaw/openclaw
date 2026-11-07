/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import { createGatewayStoreTestStore } from "../app/gateway-store.test-support.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountMenu, menuItem, settleSessionMenu } from "../test-helpers/session-menu.ts";
import { sessionMenuReasons } from "./session-menu-access.ts";

it.each([false, true])(
  "keeps lifecycle controls enabled in an offline menu (batch=%s)",
  async (batch) => {
    const store = createGatewayStoreTestStore();
    store.gateway.start();
    onTestFinished(() => store.gateway.stop());
    const client = store.current();
    client.testOptions.onHello?.(
      gatewayHelloForMethods([
        "sessions.patch",
        "sessions.patchMany",
        "sessions.delete",
        "sessions.groups.put",
      ]),
    );
    client.testOptions.onClose?.({ code: 1006, reason: "lost", willRetry: true });
    const row = { key: "agent:main:notes", sessionId: "notes-id", sharingRole: "owner" as const };
    const readReasons = () =>
      sessionMenuReasons({
        snapshot: store.gateway.snapshot,
        session: row,
        batchRows: batch ? [row, { ...row, key: "agent:main:other", sessionId: "other-id" }] : null,
      });
    const menu = await mountMenu({
      session: { target: { key: row.key }, sessionId: row.sessionId },
      selectionCount: batch ? 2 : 1,
      actionDisabledReasons: readReasons(),
    });
    expect(menuItem(menu, batch ? "Archive 2" : "Archive session").disabled).toBe(false);
    expect(menuItem(menu, batch ? "Delete 2…" : "Delete…").disabled).toBe(false);
    expect(readReasons()["new-group"]).toBeDefined();
    expect(readReasons()["toggle-pin"]).toBeUndefined();
    store.gateway.stop();
    menu.actionDisabledReasons = readReasons();
    await settleSessionMenu(menu);
    expect(menuItem(menu, batch ? "Archive 2" : "Archive session").disabled).toBe(true);
    expect(menuItem(menu, batch ? "Delete 2…" : "Delete…").disabled).toBe(true);
  },
);
