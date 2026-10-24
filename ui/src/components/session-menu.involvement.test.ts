/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { ApplicationContextProvider } from "../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import {
  menuItem,
  menuPanel,
  mountMenu,
  openSubmenu,
  selectMenuValue,
  settleSessionMenu,
} from "../test-helpers/session-menu.ts";
import { createSessionOwnerMenuHarness } from "../test-helpers/session-owner-menu.ts";

const hello = (multiple: boolean | undefined) => ({
  ...gatewayHelloForMethods(["sessions.setInvolvement"]),
  policy: multiple === undefined ? {} : { hasMultipleSessionSharingIdentities: multiple },
});

describe("personal involvement menu identity gate", () => {
  it.each([
    { compact: false, involvingMeContext: false },
    { compact: true, involvingMeContext: false },
    { compact: false, involvingMeContext: true },
    { compact: true, involvingMeContext: true },
  ])(
    "gates personal choices in $compact menus with list context $involvingMeContext",
    async ({ compact, involvingMeContext }) => {
      const owner = createSessionOwnerMenuHarness();
      const onAction = vi.fn();
      const menu = await mountMenu({
        context: owner.context,
        compact,
        involvingMeContext,
        session: { hiddenFromInvolvingMe: false },
        onAction,
      });
      const openChoices = async () => {
        if (!menuPanel(menu).matches(":popover-open")) {
          menu.anchor = { x: 100, y: 100 };
          await settleSessionMenu(menu);
        }
        if (!involvingMeContext) {
          if (compact) {
            if (menu.querySelector('[data-value="compact:open-advanced"]')) {
              await selectMenuValue(menu, "compact:open-advanced");
              await settleSessionMenu(menu);
            }
          } else if (!menuPanel(menuItem(menu, "Advanced")).matches(":popover-open")) {
            await openSubmenu(menu, "Advanced");
          }
        }
      };
      for (const hidden of [false, true]) {
        menu.session = { ...menu.session, hiddenFromInvolvingMe: hidden };
        for (const multiple of [undefined, false, true, false]) {
          owner.publish({ hello: hello(multiple) });
          await settleSessionMenu(menu);
          await openChoices();
          const item = menu.querySelector('[data-value="toggle-involving-me"]');
          expect(item !== null).toBe(multiple === true);
          if (multiple) {
            expect(item?.closest('[role="menu"]')).toBe(
              !compact && !involvingMeContext
                ? menuPanel(menuItem(menu, "Advanced"))
                : menuPanel(menu),
            );
            expect(item?.textContent).toContain(
              hidden ? "Show in Involving me" : "Hide from Involving me",
            );
          }
          onAction.mockClear();
          if (multiple) {
            await selectMenuValue(menu, "toggle-involving-me");
            expect(onAction).toHaveBeenCalledWith({ kind: "toggle-involving-me" });
          }
          expect(onAction).toHaveBeenCalledTimes(multiple ? 1 : 0);
        }
      }
      owner.publish({ hello: hello(true) });
      await settleSessionMenu(menu);
      expect(menu.querySelector('[data-value="toggle-involving-me"]')).not.toBeNull();
      const replacement = createSessionOwnerMenuHarness();
      replacement.publish({ hello: hello(false) });
      (menu.parentElement as ApplicationContextProvider).setContext(replacement.context);
      await settleSessionMenu(menu);
      expect(menu.querySelector('[data-value="toggle-involving-me"]')).toBeNull();
      owner.publish({ hello: hello(true) });
      await settleSessionMenu(menu);
      expect(menu.querySelector('[data-value="toggle-involving-me"]')).toBeNull();
    },
  );
});
