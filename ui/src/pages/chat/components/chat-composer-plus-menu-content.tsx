import { createMemo, lazy, Show } from "solid-js";
import { warmWhenIdle } from "../../../lib/idle-warmup.ts";
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
warmWhenIdle(ChatComposerCapabilityInitializer.preload);

export function ChatComposerPlusMenuContent(props: ChatComposerPlusMenuBodyProps) {
  const resolved = createMemo<ChatComposerPlusMenuContentProps | undefined>((previous) => {
    const current = props.menu;
    // Keep the native menu's retained rows dormant while it is closed.
    if (!current.open && (previous || !props.readMenu().overlay.open)) {
      return previous;
    }
    const capabilityMenu = current.capabilityMenu?.read();
    if (current.capabilityMenu && !capabilityMenu) {
      return undefined;
    }
    return {
      ...current,
      ...capabilityMenu,
      showCapabilities: capabilityMenu !== undefined,
      basePath: capabilityMenu?.basePath ?? "",
      skills: capabilityMenu?.skills ?? null,
      skillsRead: capabilityMenu?.skillsRead ?? null,
      mcpServers: capabilityMenu?.mcpServers ?? [],
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
    <Show when={resolved()} fallback={<InitializeCapability {...props} />}>
      {(menu) => <ChatComposerPlusMenuBody {...props} menu={menu()} open={props.menu.open} />}
    </Show>
  );
}

function InitializeCapability(props: ChatComposerPlusMenuBodyProps) {
  return (
    <>
      <Show
        when={
          (props.menu.open || props.readMenu().overlay.open) &&
          props.menu.capabilityMenu?.initialize
        }
      >
        {(initialize) => <ChatComposerCapabilityInitializer initialize={initialize()} />}
      </Show>
      {props.renderItems(() => [
        { id: "plus-menu-loading", label: t("common.loading"), disabled: true },
      ])}
    </>
  );
}
