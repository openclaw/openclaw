import { createSignal } from "solid-js";
import { onTestFinished, vi } from "vitest";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatToolCard, type ToolCardOptions } from "./chat-tool-cards.solid.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import { ToolPreview } from "./widget-card.ts";

type CardState = { card: ToolCard; options: ToolCardOptions };
const cards = new Map<HTMLElement, (state: CardState) => void>();

export async function mountCard(
  card: ToolCard,
  options: Partial<ToolCardOptions> = {},
  container = document.createElement("div"),
) {
  const state = {
    card,
    options: { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn(), ...options },
  };
  const update = cards.get(container);
  if (update) {
    update(state);
  } else {
    if (!container.isConnected) {
      document.body.append(container);
    }
    let set!: (state: CardState) => void;
    const root = mountSolid(
      () => {
        const [current, setCurrent] = createSignal<CardState>(state);
        set = setCurrent;
        return <ChatToolCard card={current().card} options={current().options} />;
      },
      { container },
    );
    cards.set(container, set);
    onTestFinished(() => {
      cards.delete(container);
      root.unmount();
      container.remove();
    });
  }
  flush();
  await settleToolBridges(container);
  return container;
}

export function mountPreview(
  preview: Parameters<typeof ToolPreview>[0]["preview"],
  surface: Parameters<typeof ToolPreview>[0]["surface"],
  options: Parameters<typeof ToolPreview>[0]["options"],
  container: HTMLElement,
) {
  const root = mountSolid(
    () => <ToolPreview preview={preview} surface={surface} options={options} />,
    { container },
  );
  onTestFinished(root.unmount);
  flush();
}
