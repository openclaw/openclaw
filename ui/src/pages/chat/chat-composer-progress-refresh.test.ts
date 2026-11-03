/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  renderComposerFixture as renderComposer,
  resetComposerFixture,
  disposeComposer,
} from "./chat-composer.test-support.ts";
afterEach(() => resetComposerFixture());

describe("progress card refresh admission", () => {
  it.each([
    { connected: true, canSend: true, visible: true },
    { connected: false, canSend: true, visible: false },
    { connected: true, canSend: false, visible: false },
  ])(
    "shows refresh only for writable connected composers: %j",
    async ({ connected, canSend, visible }) => {
      const onRefresh = vi.fn();
      const card = {
        sessionKey: "agent:main:work",
        revision: 1,
        updatedAt: 1,
        markdown: "Prior progress",
      };
      const view = renderComposer({
        connected,
        canSend,
        progressCard: card,
        progressCardRefresh: { onRefresh },
      });
      document.body.append(view.container);
      onTestFinished(() => {
        disposeComposer(view.container);
        view.container.remove();
      });
      await vi.dynamicImportSettled();
      await waitForSolid(() =>
        expect(view.container.querySelector(".session-progress-card--composer")).not.toBeNull(),
      );
      const options = view.container.querySelector<HTMLButtonElement>(
        ".session-progress-card__options",
      );
      options?.click();
      flush();
      if (options) {
        await vi.waitFor(() => expect(options.getAttribute("aria-expanded")).toBe("true"));
      }
      const refresh = view.container.querySelector<HTMLButtonElement>(
        ".session-progress-card__refresh",
      );
      expect(Boolean(refresh)).toBe(visible);
      refresh?.click();
      expect(onRefresh).toHaveBeenCalledTimes(visible ? 1 : 0);
      expect(view.props.onSend).not.toHaveBeenCalled();
      expect(view.props.messages).toEqual([]);
      expect(view.props.queue).toEqual([]);
    },
  );
});
