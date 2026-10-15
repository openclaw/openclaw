import { html, nothing, render } from "lit";
import { onTestFinished } from "vitest";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { renderPluginSurface } from "../../../plugins/control-ui-view.ts";
import type { ToolCardOptions } from "./chat-tool-cards.solid.tsx";
import { toolResultSurfaceProps } from "./chat-tool-render-model.ts";
import "./chat-tool-cards.solid.tsx";

// Keep the Lit child subtree stable while the native Solid card parks it collapsed.
export function renderToolCard(card: ToolCard, options: ToolCardOptions & { children?: unknown }) {
  return renderPluginSurface(
    "tool-result",
    toolResultSurfaceProps(card, options),
    html`<openclaw-chat-tool-card
      style="display: contents"
      .card=${card}
      .options=${options}
      .hasChildren=${Boolean(options.children)}
      ><div style="display: contents">
        ${options.expanded ? options.children : nothing}
      </div></openclaw-chat-tool-card
    >`,
    options.presented ?? true,
  );
}

export async function settleToolBridges(container: HTMLElement) {
  const settled = new Set<HTMLElement>();
  // A parent commit can connect another bridge that was parked in its child fragment.
  for (;;) {
    const pending = Array.from(
      container.querySelectorAll<HTMLElement & { updateComplete?: Promise<unknown> }>("*"),
    ).filter((element) => element.updateComplete && !settled.has(element));
    if (pending.length === 0) {
      return;
    }
    pending.forEach((element) => settled.add(element));
    await Promise.all(pending.map((element) => Promise.resolve(element.updateComplete)));
  }
}

// Exercise the actual Lit entry point, including connected Solid bridge roots.
export async function renderToolFixture(value: unknown, container: HTMLElement) {
  if (!container.isConnected) {
    document.body.append(container);
    onTestFinished(() => {
      render(null, container);
      container.remove();
    });
  }
  render(value, container);
  await settleToolBridges(container);
}
