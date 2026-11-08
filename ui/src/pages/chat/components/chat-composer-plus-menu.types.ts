import type { JSX } from "@solidjs/web";
import type { IconName } from "../../../components/solid/icon.tsx";
import type {
  MenuControls,
  MenuEntry,
  MenuHandle,
  MenuItem,
} from "../../../components/solid/menu.tsx";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import type { ChatComposerCapabilityHost } from "../chat-composer-capability-host.tsx";
import type {
  ChatComposerCapabilityMenuProps,
  ChatComposerPlusMenuView,
} from "../composer-capability-types.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import type { ChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";

export type ChatComposerPlusMenuProps = {
  attachments: ChatAttachmentControlsProps;
  inputHandle: ChatAttachmentInputHandle;
  capabilityMenu?: ChatComposerCapabilityMenuSource;
  disabled: boolean;
  open: boolean;
  view: ChatComposerPlusMenuView;
  toolOverrides: SessionToolOverrides | null | undefined;
  rootToggles?: readonly {
    value: string;
    label: string;
    icon?: IconName;
    checked: boolean;
    disabled: boolean;
    title?: string;
    onChange: (checked: boolean) => void;
  }[];
  onOpenChange: (open: boolean) => void;
  onViewChange: (view: ChatComposerPlusMenuView) => void;
};

export type ChatComposerCapabilityMenuSource = {
  initialize?: (create: () => ChatComposerCapabilityHost) => void;
  read: () => ChatComposerCapabilityMenuProps | undefined;
};

export type ChatComposerPlusMenuContentProps = ChatComposerPlusMenuProps &
  ChatComposerCapabilityMenuProps & { showCapabilities: boolean };

export type ChatComposerPlusMenuHandlers = {
  items(): readonly MenuEntry[];
  select(item: MenuItem, event: CustomEvent<MenuItem>): void;
  navigate(value: string): void;
};

export type ChatComposerPlusMenuBodyProps = {
  menu: ChatComposerPlusMenuProps;
  view: ChatComposerPlusMenuView;
  readMenu: () => MenuHandle;
  onReady: (handlers: ChatComposerPlusMenuHandlers | undefined) => void;
  controls: MenuControls;
  renderItems: (items: () => readonly MenuEntry[]) => JSX.Element;
};

export type ChatComposerPlusMenuResolvedProps = Omit<ChatComposerPlusMenuBodyProps, "menu"> & {
  menu: ChatComposerPlusMenuContentProps;
  open: boolean;
};

export type ChatComposerPlusMenuSubviewProps = ChatComposerPlusMenuResolvedProps & {
  searching: boolean;
  query: string;
  searchHeight: number | undefined;
  expanded: string | null;
  onSearchingChange: (value: boolean) => void;
  onQueryChange: (value: string) => void;
  onSearchHeightChange: (value: number | undefined) => void;
  onExpandedChange: (value: string | null) => void;
  closeSearch: () => boolean;
  changeView: (view: ChatComposerPlusMenuView) => void;
};
