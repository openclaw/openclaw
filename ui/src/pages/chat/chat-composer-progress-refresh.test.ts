/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  renderComposerFixture as renderComposer,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
afterEach(() => resetComposerFixture());

describe("progress card refresh admission", () => {
  it.each([
    { connected: true, canSend: true, visible: true },
    { connected: false, canSend: true, visible: false },
    { connected: true, canSend: false, visible: false },
  ])(
    "shows refresh only for writable connected composers: %j",
    ({ connected, canSend, visible }) => {
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
      onTestFinished(() => {
        render(html``, view.container);
      });
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
