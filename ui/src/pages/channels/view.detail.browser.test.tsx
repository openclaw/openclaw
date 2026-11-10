import { createSignal, flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import "../../styles/channels.css";
import "../../styles/settings.css";
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

it("keeps channel fields and completion actions inset and reachable without visiting Config", async () => {
  let setups = 0;
  const props = createChannelsViewProps(null, null, {
    config: {
      configForm: { channels: { telegram: { allowFrom: Array(12).fill("demo-user") } } },
      configUiHints: { "channels.telegram.allowFrom.*": { advanced: false } },
      configSchema: {
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              telegram: {
                type: "object",
                properties: { allowFrom: { type: "array", items: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  });
  const [current, setCurrent] = createSignal(props);
  host = document.body.appendChild(document.createElement("div"));
  view = mountSolid(
    () =>
      renderChannelDetail({
        channelId: "telegram",
        label: "Telegram",
        get props() {
          return current();
        },
        onClose: () => {},
        onSetup: () => {
          setups++;
        },
      }),
    { container: host },
  );
  const { dialog } = await getRenderedModalDialog(host);
  await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  for (const width of [1400, 820, 390, 320]) {
    await page.viewport(width, 900);
    const input = host.querySelector<HTMLInputElement>(".cfg-array input")!;
    input.scrollIntoView({ block: "center" });
    const inputBounds = input.getBoundingClientRect();
    const remove = host
      .querySelector<HTMLElement>(".cfg-array__item button")!
      .getBoundingClientRect();
    expect.soft(remove.left).toBeGreaterThan(inputBounds.right);
    expect
      .soft(Math.abs(remove.top + remove.height / 2 - inputBounds.top - inputBounds.height / 2))
      .toBeLessThan(1);
    for (const dirty of [false, true]) {
      setCurrent({
        ...props,
        configEdits: dirty
          ? {
              telegram: [
                { path: ["channels", "telegram", "allowFrom"], value: Array(12).fill("edited") },
              ],
            }
          : {},
        saveFeedback: dirty
          ? { channelId: "telegram", kind: "error", message: "Could not save. Try again." }
          : null,
      });
      flush();
      host.querySelector<HTMLElement>(".channels-detail__body")!.scrollTop = 10000;
      const bounds = dialog.getBoundingClientRect();
      const panel = host.querySelector<HTMLElement>(".channels-detail")!;
      const actions = [
        ...panel.querySelectorAll<HTMLElement>(".channels-detail__footer :is(a,button)"),
      ];
      expect(panel.getBoundingClientRect().width).toBeLessThanOrEqual(bounds.width + 1);
      expect(actions).toHaveLength(dirty ? 4 : 2);
      for (const action of actions) {
        const rect = action.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(bounds.left + 19);
        expect(rect.right).toBeLessThanOrEqual(bounds.right - 19);
        expect(rect.top).toBeGreaterThanOrEqual(bounds.top - 1);
        expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom - 19);
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        expect(hit === action || action.contains(hit)).toBe(true);
      }
    }
  }
  await userEvent.click(host.querySelector<HTMLButtonElement>(".channels-detail__footer button")!);
  expect(setups).toBe(1);
});
