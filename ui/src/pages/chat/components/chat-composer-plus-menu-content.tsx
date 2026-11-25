import { createMemo, createSignal, lazy, Loading, Show } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatComposerPlusMenuBody } from "./chat-composer-plus-menu-body.tsx";
import type {
  ChatComposerPlusMenuBodyProps,
  ChatComposerPlusMenuContentProps,
} from "./chat-composer-plus-menu.types.ts";

const ChatComposerCapabilityInitializer = lazy(
  () => import("../chat-composer-capability-host.tsx"),
  { export: "ChatComposerCapabilityInitializer" },
);

export function ChatComposerPlusMenuContent(props: ChatComposerPlusMenuBodyProps) {
  const [capabilityRevision, refreshCapability] = createSignal(0);
  const resolved = createMemo<ChatComposerPlusMenuContentProps | undefined>((previous) => {
    const current = props.menu;
    // Keep the native menu's retained rows dormant while it is closed.
    if (!current.open && (previous || !props.readMenu().overlay.open)) {
      return previous;
    }
    capabilityRevision();
    const capabilityMenu = current.capabilityMenu?.read();
    return {
      ...current,
      ...capabilityMenu,
      showCapabilities: capabilityMenu !== undefined,
      basePath: capabilityMenu?.basePath ?? "",
      skills: capabilityMenu?.skills ?? null,
      skillsRead: capabilityMenu?.skillsRead ?? null,
      mcpServers: capabilityMenu?.mcpServers ?? [],
      mcpServersReadState: capabilityMenu?.mcpServersReadState ?? "unavailable",
      toolsEffectiveResult: capabilityMenu?.toolsEffectiveResult ?? null,
      toolsEffectiveLoading: capabilityMenu?.toolsEffectiveLoading ?? false,
      toolsEffectiveError: capabilityMenu?.toolsEffectiveError ?? false,
      toolAccessMutationBlockedReason: capabilityMenu?.toolAccessMutationBlockedReason ?? null,
      webSearchBaseEnabled: capabilityMenu?.webSearchBaseEnabled ?? true,
      mutationBlockedReason: capabilityMenu?.mutationBlockedReason ?? null,
      canAdmin: capabilityMenu?.canAdmin ?? false,
      adminBlockedReason: capabilityMenu?.adminBlockedReason ?? null,
      onLoadSkills: capabilityMenu?.onLoadSkills ?? (() => {}),
      onPatchToolOverrides: capabilityMenu?.onPatchToolOverrides ?? (() => {}),
      onNavigate: capabilityMenu?.onNavigate ?? (() => {}),
    };
  });
  return (
    <>
      <Show
        when={resolved()}
        fallback={props.renderItems(() => [
          { id: "plus-menu-loading", label: t("common.loading"), disabled: true },
        ])}
      >
        {(menu) => <ChatComposerPlusMenuBody {...props} menu={menu()} open={props.menu.open} />}
      </Show>
      <Show
        when={
          props.menu.open && !resolved()?.showCapabilities && props.menu.capabilityMenu?.initialize
        }
      >
        {(initialize) => (
          <Loading>
            <ChatComposerCapabilityInitializer
              initialize={(create) => {
                initialize()(create);
                refreshCapability((revision) => revision + 1);
                if (props.readMenu().overlay.open) {
                  props.menu.capabilityMenu?.read()?.onLoadSkills();
                }
              }}
            />
          </Loading>
        )}
      </Show>
    </>
  );
}
