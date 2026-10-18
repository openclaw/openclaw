import { createMemo, For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { SidebarSlotId } from "../sidebar-layout.ts";
import type {
  SidebarPanelDefinition,
  SidebarRegionCallbacks,
} from "./chat-sidebar-region-types.ts";
import "./chat-panel-launcher-mobile.css";

type LauncherDefinition = Pick<SidebarPanelDefinition, "slot" | "label" | "icon" | "available">;

export type MobilePanelLauncherProps = {
  definitions: readonly LauncherDefinition[];
  /** The host owns native create/select behavior and returning from the launcher. */
  onOpen: SidebarRegionCallbacks["openSlot"];
};

const quickSlots: readonly SidebarSlotId[] = ["companion", "workspace", "browser"];
const exploreSlots: readonly SidebarSlotId[] = [
  "detail",
  "link-reader",
  "subagents",
  "processes",
  "desktop",
  "portal",
  "dashboard",
];

function LauncherOption(props: {
  definition: LauncherDefinition;
  onOpen: MobilePanelLauncherProps["onOpen"];
}) {
  return (
    <button
      type="button"
      class="chat-panel-launcher-mobile__option"
      disabled={!props.definition.available}
      onClick={() => props.onOpen(props.definition.slot)}
    >
      <span class="chat-panel-launcher-mobile__icon" aria-hidden="true">
        <Icon name={props.definition.icon} />
      </span>
      <span class="chat-panel-launcher-mobile__label">{props.definition.label}</span>
    </button>
  );
}

/** Same controlled content for empty Panels and +; no tabs or resource state live here. */
export function MobilePanelLauncher(props: MobilePanelLauncherProps) {
  const available = createMemo(() =>
    props.definitions.filter(
      (definition) => definition.available && definition.slot !== "conversation",
    ),
  );
  const quick = createMemo(() =>
    quickSlots.flatMap((slot) =>
      props.definitions.filter(
        (definition) => definition.slot === slot && (definition.available || slot === "browser"),
      ),
    ),
  );
  const explore = createMemo(() => [
    ...exploreSlots.flatMap((slot) => available().filter((definition) => definition.slot === slot)),
    ...available().filter(
      (definition) =>
        !quickSlots.includes(definition.slot) &&
        !exploreSlots.includes(definition.slot) &&
        definition.slot !== "terminal",
    ),
    ...available().filter((definition) => definition.slot === "terminal"),
  ]);
  return (
    <div class="chat-panel-launcher-mobile">
      <Show when={quick().length > 0}>
        <section aria-label={t("chat.sidePanel.quickAccess")}>
          <h3>{t("chat.sidePanel.quickAccess")}</h3>
          <div class="chat-panel-launcher-mobile__quick">
            <For each={quick()} keyed={(definition) => definition.slot}>
              {(definition) => <LauncherOption definition={definition()} onOpen={props.onOpen} />}
            </For>
          </div>
        </section>
      </Show>
      <Show when={explore().length > 0}>
        <section aria-label={t("chat.sidePanel.explorePanels")}>
          <h3>{t("chat.sidePanel.explorePanels")}</h3>
          <div class="chat-panel-launcher-mobile__explore">
            <For each={explore()} keyed={(definition) => definition.slot}>
              {(definition) => <LauncherOption definition={definition()} onOpen={props.onOpen} />}
            </For>
          </div>
        </section>
      </Show>
    </div>
  );
}
