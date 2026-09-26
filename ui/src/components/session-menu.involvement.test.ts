/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { ApplicationContextProvider } from "../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountMenu, selectMenuValue } from "../test-helpers/session-menu.ts";
import { createSessionOwnerMenuHarness } from "../test-helpers/session-owner-menu.ts";

const hello = (multiple: boolean | undefined) => ({
  ...gatewayHelloForMethods(["sessions.setInvolvement"]),
  policy: multiple === undefined ? {} : { hasMultipleSessionSharingIdentities: multiple },
});

describe("personal involvement menu identity gate", () => {
  it.each([false, true])("gates both personal choices in compact=%s menus", async (compact) => {
    const owner = createSessionOwnerMenuHarness();
    const onAction = vi.fn();
    const menu = await mountMenu({
      context: owner.context,
      compact,
      session: { hiddenFromInvolvingMe: false },
      onAction,
    });
    for (const hidden of [false, true]) {
      menu.session = { ...menu.session, hiddenFromInvolvingMe: hidden };
      for (const multiple of [undefined, false, true, false]) {
        owner.publish({ hello: hello(multiple) });
        await menu.updateComplete;
        const item = menu.querySelector('[value="toggle-involving-me"]');
        expect(item !== null).toBe(multiple === true);
        if (multiple) {
          expect(item?.textContent).toContain(
            hidden ? "Show in Involving me" : "Hide from Involving me",
          );
        }
        onAction.mockClear();
        selectMenuValue(menu, "toggle-involving-me");
        expect(onAction).toHaveBeenCalledTimes(multiple ? 1 : 0);
      }
    }
    owner.publish({ hello: hello(true) });
    await menu.updateComplete;
    expect(menu.querySelector('[value="toggle-involving-me"]')).not.toBeNull();
    const replacement = createSessionOwnerMenuHarness();
    replacement.publish({ hello: hello(false) });
    (menu.parentElement as ApplicationContextProvider).setContext(replacement.context);
    await menu.updateComplete;
    expect(menu.querySelector('[value="toggle-involving-me"]')).toBeNull();
    owner.publish({ hello: hello(true) });
    await menu.updateComplete;
    expect(menu.querySelector('[value="toggle-involving-me"]')).toBeNull();
  });
});
