import { createMemo, createSignal, lazy, onSettled, Show } from "solid-js";
import PluginArtwork from "../../../components/plugin-artwork.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuEntry, MenuItem } from "../../../components/solid/menu.tsx";
import { registerChatComposerMenuEnglish } from "../../../i18n/locales/en-chat-composer-menu.ts";
import { i18nRevision, registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  countSessionToolOverrides,
  nextWebSearchToolOverrides,
  resolveWebSearchToolOverrideState,
} from "../../../lib/sessions/tool-overrides.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ChatComposerPlusMenuView } from "../composer-capability-types.ts";
import "./chat-camera-capture.tsx";
import {
  composerAttachmentMenuItems,
  handleComposerAttachmentSelection,
} from "./chat-composer-attachment-menu.tsx";
import {
  menuChevron,
  renderBackRow,
  renderCapabilityMenuState,
  renderCapabilityToggleRow,
  menuDivider,
} from "./chat-composer-menu-rows.tsx";
import { ChatComposerPlusMenuFrame } from "./chat-composer-plus-menu-frame.tsx";
import type {
  ChatComposerPlusMenuContentProps,
  ChatComposerPlusMenuResolvedProps,
} from "./chat-composer-plus-menu.types.ts";

registerEnglishCatalog(registerChatComposerMenuEnglish);

const Subview = lazy(() => import("./chat-composer-plus-menu-subview.tsx"), {
  export: "ChatComposerPlusMenuSubview",
});

function rootRenderInputs(menu: ChatComposerPlusMenuContentProps) {
  const inputs: unknown[] = [i18nRevision()];
  for (const action of menu.pluginActions ?? []) {
    inputs.push(action.pluginId, action.pluginName);
  }
  inputs.push(uploadsEnabled(menu.attachments.uploadConfig), menu.showCapabilities);
  for (const toggle of menu.rootToggles ?? []) {
    inputs.push(
      toggle.value,
      toggle.label,
      toggle.icon,
      toggle.checked,
      toggle.disabled,
      toggle.title,
    );
  }
  if (menu.showCapabilities) {
    inputs.push(
      menu.basePath,
      menu.mutationBlockedReason,
      menu.webSearchBaseEnabled,
      menu.toolOverrides?.webSearch,
      countSessionToolOverrides(menu.toolOverrides),
    );
  }
  return inputs;
}

function rootItems(menu: ChatComposerPlusMenuContentProps): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const attachments = composerAttachmentMenuItems(menu);
  const plugins = Array.from(
    new Map(menu.pluginActions?.map((action) => [action.pluginId, action.pluginName])),
    ([id, label]): MenuItem => ({
      id: `plugin:${id}`,
      label,
      icon: <PluginArtwork pluginId={id} fallback={<Icon name="plug" />} />,
      details: menuChevron(),
      class: "agent-chat__capability-menu-item",
      closeOnSelect: false,
    }),
  );
  const finish = (): MenuEntry[] => {
    const rows: MenuEntry[] = [
      ...attachments,
      ...(entries.length && attachments.length ? [menuDivider("attachment-divider")] : []),
      ...entries,
      ...(plugins.length && (entries.length || attachments.length)
        ? [menuDivider("plugin-actions-divider")]
        : []),
      ...plugins,
    ];
    return plugins.length
      ? [
          {
            kind: "group",
            id: "root-list",
            class: "chat-plugin-menu-scroll",
            items: rows,
          },
        ]
      : rows;
  };
  if (menu.showCapabilities || menu.rootToggles?.length) {
    entries.push(...(menu.rootToggles ?? []).map(renderCapabilityToggleRow));
  }
  if (!menu.showCapabilities) {
    return finish();
  }
  for (const view of ["skills", "connectors"] as const) {
    entries.push({
      id: `open-${view}`,
      label: t(`chat.composer.menu.${view}`),
      class: "agent-chat__capability-menu-item",
      icon: <Icon name={view === "skills" ? "book" : "plug"} />,
      details: menuChevron(),
      closeOnSelect: false,
    });
  }
  const staleWebSearchEnable = !menu.webSearchBaseEnabled && menu.toolOverrides?.webSearch === true;
  entries.push(
    renderCapabilityToggleRow({
      value: "toggle-web-search",
      label: t("chat.composer.menu.webSearch"),
      checked: resolveWebSearchToolOverrideState(
        menu.webSearchBaseEnabled,
        menu.toolOverrides?.webSearch,
      ),
      disabled:
        menu.mutationBlockedReason !== null ||
        (!menu.webSearchBaseEnabled && !staleWebSearchEnable),
      title:
        menu.mutationBlockedReason ??
        (staleWebSearchEnable
          ? t("chat.composer.menu.webSearchClearStaleEnable")
          : !menu.webSearchBaseEnabled
            ? t("chat.composer.menu.webSearchGloballyDisabled")
            : ""),
      icon: "globe",
    }),
  );
  if (menu.mutationBlockedReason === t("chat.composer.menu.offlineBlocked")) {
    entries.push(renderCapabilityMenuState("capability-blocked", menu.mutationBlockedReason));
  }
  const overrideCount = countSessionToolOverrides(menu.toolOverrides);
  if (overrideCount > 0) {
    entries.push(menuDivider("overrides-divider"), {
      id: "clear-overrides",
      label: t(
        overrideCount === 1
          ? "chat.composer.menu.sessionChange"
          : "chat.composer.menu.sessionChanges",
        { count: String(overrideCount) },
      ),
      class: "agent-chat__capability-menu-item agent-chat__capability-menu-overrides",
      disabled: menu.mutationBlockedReason !== null,
      attributes: { title: menu.mutationBlockedReason ?? "" },
      icon: <Icon name="rotateCcw" />,
      details: (
        <span class="agent-chat__capability-menu-clear-overrides" aria-hidden="true">
          {t("chat.composer.menu.reset")}
        </span>
      ),
      closeOnSelect: false,
    });
  }
  return finish();
}

export function ChatComposerPlusMenuBody(props: ChatComposerPlusMenuResolvedProps) {
  // These values outlive subview mounts, including the controlled reset on close.
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [searchHeight, setSearchHeight] = createSignal<number>();
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const closeSearch = () => {
    if (!searching()) {
      return false;
    }
    setSearching(false);
    setQuery("");
    setSearchHeight(undefined);
    onSettled(() => {
      if (props.open) {
        props.readMenu().itemElement("back")?.focus({ preventScroll: true });
      }
    });
    return true;
  };
  const changeView = (view: ChatComposerPlusMenuView) => {
    const menu = props.readMenu();
    const { overlay } = menu;
    const { surface } = overlay;
    const focused = surface.ownerDocument.activeElement;
    closeSearch();
    props.menu.onViewChange(view);
    onSettled(() => {
      const active = surface.ownerDocument.activeElement;
      // A controlled close can settle before Menu applies it; newer focus also wins.
      if (
        overlay.open &&
        props.open &&
        (active === focused || (active === surface.ownerDocument.body && !focused?.isConnected))
      ) {
        menu.focusFirst();
      }
    });
  };
  const select = ({ id: value }: MenuItem, event: CustomEvent<MenuItem>) => {
    const menu = props.menu;
    if (handleComposerAttachmentSelection(value, event, props.readMenu(), menu)) {
      return;
    }
    if (value.startsWith("plugin:")) {
      event.preventDefault();
      changeView(`plugin:${value.slice("plugin:".length)}`);
      return;
    }
    if (value === "back") {
      event.preventDefault();
      changeView("root");
      return;
    }
    const action = menu.pluginActions?.find((entry) => `action:${entry.key}` === value);
    if (action && !action.disabled) {
      action.run();
      return;
    }
    const rootToggle = menu.rootToggles?.find((toggle) => toggle.value === value);
    if (rootToggle) {
      event.preventDefault();
      if (!rootToggle.disabled) {
        rootToggle.onChange(!rootToggle.checked);
      }
      return;
    }
    if (value === "open-skills" || value === "open-connectors") {
      event.preventDefault();
      changeView(value === "open-skills" ? "skills" : "connectors");
      return;
    }
    if (value === "toggle-web-search") {
      event.preventDefault();
      if (
        menu.mutationBlockedReason ||
        (!menu.webSearchBaseEnabled && menu.toolOverrides?.webSearch !== true)
      ) {
        return;
      }
      menu.onPatchToolOverrides(
        nextWebSearchToolOverrides(
          menu.toolOverrides,
          menu.webSearchBaseEnabled &&
            !resolveWebSearchToolOverrideState(
              menu.webSearchBaseEnabled,
              menu.toolOverrides?.webSearch,
            ),
          menu.webSearchBaseEnabled,
        ),
      );
      return;
    }
    if (value === "clear-overrides") {
      event.preventDefault();
      if (!menu.mutationBlockedReason) {
        menu.onPatchToolOverrides(null);
      }
    }
  };
  const rootInputs = createMemo(
    () => ({ menu: props.menu, values: rootRenderInputs(props.menu) }),
    {
      lazy: true,
      equals: (previous, next) =>
        previous.values.length === next.values.length &&
        previous.values.every((value, index) => Object.is(value, next.values[index])),
    },
  );
  const items = createMemo(
    (): MenuEntry[] => {
      if (!props.view.startsWith("plugin:")) {
        return rootItems(rootInputs().menu);
      }
      const actions = props.menu.pluginActions?.filter(
        (entry) => entry.pluginId === props.view.slice("plugin:".length),
      );
      if (!actions?.length) {
        return rootItems(rootInputs().menu);
      }
      return [
        renderBackRow(actions[0]!.pluginName),
        menuDivider("plugin-header-divider"),
        {
          kind: "group",
          id: "plugin-options",
          class: "chat-plugin-menu-scroll",
          items: actions.map((action) => ({
            id: `action:${action.key}`,
            label: action.running ? `${t("common.cancel")}: ${action.label}` : action.label,
            disabled: action.disabled,
            icon: <Icon name={action.running ? "square" : action.icon} />,
            class: "agent-chat__capability-menu-item",
          })),
        },
      ];
    },
    { lazy: true },
  );
  onSettled(() => {
    if (props.readMenu().overlay.open) {
      props.menu.onLoadSkills();
    }
  });
  return (
    <Show
      when={props.view === "root" || props.view.startsWith("plugin:")}
      fallback={
        <Subview
          {...props}
          searching={searching()}
          query={query()}
          searchHeight={searchHeight()}
          expanded={expanded()}
          onSearchingChange={setSearching}
          onQueryChange={setQuery}
          onSearchHeightChange={setSearchHeight}
          onExpandedChange={setExpanded}
          closeSearch={closeSearch}
          changeView={changeView}
        />
      }
    >
      <ChatComposerPlusMenuFrame {...props} items={items} select={select} />
    </Show>
  );
}
