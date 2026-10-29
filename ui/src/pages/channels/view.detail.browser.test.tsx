import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import "../../styles/channels.css";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { renderChannelDetail } from "./view.detail.tsx";
import { createChannelsViewProps } from "./view.test-support.ts";

const viewport = { width: window.innerWidth, height: window.innerHeight };
let host: HTMLDivElement | undefined;
let view: ReturnType<typeof mountSolid> | undefined;
afterEach(async () => {
  view?.unmount();
  host?.remove();
  await page.viewport(viewport.width, viewport.height);
});

it("keeps channel completion links inside the native modal at desktop and narrow widths", async () => {
  let setups = 0;
  const props = createChannelsViewProps(null, null);
  host = document.body.appendChild(document.createElement("div"));
  view = mountSolid(
    () =>
      renderChannelDetail({
        channelId: "telegram",
        label: "Telegram",
        props,
        onClose: () => {},
        onSetup: () => {
          setups++;
        },
      }),
    { container: host },
  );
  const { dialog } = await getRenderedModalDialog(host);
  await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  for (const width of [1440, 390, 320]) {
    await page.viewport(width, 1000);
    const bounds = dialog.getBoundingClientRect();
    const panel = host.querySelector<HTMLElement>(".channels-detail")!;
    const actions = [
      ...panel.querySelectorAll<HTMLElement>(".channels-detail__footer :is(a,button)"),
    ];
    expect(panel.getBoundingClientRect().width).toBeLessThanOrEqual(bounds.width + 1);
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      const rect = action.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      expect(rect.top).toBeGreaterThanOrEqual(bounds.top - 1);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      expect(hit === action || action.contains(hit)).toBe(true);
    }
  }
  await userEvent.click(host.querySelector<HTMLButtonElement>(".channels-detail__footer button")!);
  expect(setups).toBe(1);
});
