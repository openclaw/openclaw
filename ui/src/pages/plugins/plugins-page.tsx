import { createEffect, createSignal, onCleanup, onSettled } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { focusHeadingAfterRemoval } from "./plugin-removal-focus.ts";
import { PluginsPageView } from "./plugins-page-view.tsx";
import { PluginsPageController } from "./plugins-page.ts";
import type { PluginsRouteData } from "./route-data.ts";
import "../../styles/plugins.css";

export type PluginsPageProps = { routeData?: PluginsRouteData; surface?: "discovery" | "settings" };

export function PluginsPage(props: PluginsPageProps) {
  let host!: HTMLElement;
  const context = useApplication();
  // Domain notifications can arrive while a legacy child commits.
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const page = new PluginsPageController({
    context: () => context,
    notify: () => setRevision((value) => value + 1),
    onRemoval: (trigger) => onSettled(() => focusHeadingAfterRemoval(host, trigger)),
  });
  // Nested views can insert tile markers after the page-state effect.
  const tiles = new MutationObserver(() => page.afterCommit());
  createEffect(
    () => [props.routeData, props.surface] as const,
    ([routeData, surface]) => page.update(routeData, surface ?? "settings"),
  );
  createEffect(revision, () => page.afterCommit());
  onCleanup(() => {
    tiles.disconnect();
    page.dispose();
  });
  return (
    <openclaw-plugins-page
      ref={(element) => {
        host = element;
        page.element = element;
        tiles.observe(element, { childList: true, subtree: true });
      }}
    >
      <PluginsPageView page={page} revision={revision} />
    </openclaw-plugins-page>
  );
}
