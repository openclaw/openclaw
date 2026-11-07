/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import type { ChatComposerNoticesProps } from "../chat-view-notices.tsx";
import { renderChatComposerNotices } from "../chat-view-notices.tsx";

describe("guest welcome quick start", () => {
  afterEach(cleanupSolid);

  it.each([
    ["the server-selected welcome session", "agent:guest:welcome", [], [], true, true],
    ["another session with the same welcome content", "agent:guest:other", [], [], true, false],
    [
      "a guest who has already started talking",
      "agent:guest:welcome",
      [],
      [{ role: "user", content: "Hello" }],
      true,
      false,
    ],
    [
      "an operator with full access",
      "agent:guest:welcome",
      ["operator.read", "operator.write"],
      [],
      true,
      false,
    ],
    ["a session without compose permission", "agent:guest:welcome", [], [], false, false],
  ] as const)(
    "only offers contextual help for %s",
    (_name, sessionKey, scopes, messages, canSend, visible) => {
      const onDraftChange = vi.fn();
      const onGuestQuickStartFocus = vi.fn();
      const props: ChatComposerNoticesProps = {
        sessionKey,
        canSend,
        messages: [{ role: "assistant", content: "Welcome" }, ...messages],
        guestQuickStartAuth: { role: "operator", sessionCap: "view", scopes },
        guestWelcome: {
          presentation: { kind: "ready", sessionKey: "agent:guest:welcome" },
          retry: vi.fn(),
          subscribe: () => () => {},
          start: () => () => {},
        },
        onDraftChange,
        onGuestQuickStartFocus,
      };
      const { container } = mountSolid(() => renderChatComposerNotices(props));
      const buttons = [...container.querySelectorAll<HTMLButtonElement>(".agent-chat__suggestion")];
      expect(buttons).toHaveLength(visible ? 3 : 0);
      if (visible) {
        buttons[0]?.click();
        expect(onDraftChange).toHaveBeenCalledWith(
          expect.stringContaining("using the access I already have"),
        );
        expect(onGuestQuickStartFocus).toHaveBeenCalledOnce();
      }
    },
  );
});
