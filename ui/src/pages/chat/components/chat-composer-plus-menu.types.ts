import type { JSX } from "@solidjs/web";
import type { ToolsEffectiveResult } from "../../../api/types.ts";
import type { ApplicationNavigationOptions } from "../../../app/context.ts";
import type { IconName } from "../../../components/solid/icon.tsx";
import type { MenuEntry, MenuHandle, MenuItem } from "../../../components/solid/menu.tsx";
import type { McpServerSummary } from "../../../lib/config/mcp-servers.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import type { ComposerLibraryProps } from "../composer-library-session.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import type { ChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";

export type ChatComposerPlusMenuView =
  | "root"
  | "skills"
  | "connectors"
  | `tools:${string}`
  | `library:${string}`;

export type ChatComposerMenuSkill = {
  key: string;
  name: string;
  enabled: boolean;
  baseEnabled: boolean;
  missingDeps?: boolean;
  blocked?: boolean;
};

export type ChatComposerPlusMenuProps = {
  attachments: ChatAttachmentControlsProps;
  inputHandle: ChatAttachmentInputHandle;
  capabilityMenu?: ChatComposerCapabilityMenuProps;
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

export type ChatComposerCapabilityMenuProps = {
  basePath: string;
  skills: readonly ChatComposerMenuSkill[] | null;
  skillsRead: Promise<readonly ChatComposerMenuSkill[] | null> | null;
  library?: ComposerLibraryProps;
  mcpServers: readonly McpServerSummary[];
  toolsEffectiveResult: ToolsEffectiveResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: boolean;
  toolAccessMutationBlockedReason: string | null;
  webSearchBaseEnabled: boolean;
  mutationBlockedReason: string | null;
  canAdmin: boolean;
  adminBlockedReason: string | null;
  onLoadSkills: () => void;
  onLoadView?: (view: ChatComposerPlusMenuView) => void;
  onPatchToolOverrides: (next: SessionToolOverrides | null) => void;
  onNavigate: (
    routeId: "mcp" | "plugins" | "skills",
    options?: ApplicationNavigationOptions,
  ) => void;
  onAddServer?: () => void;
  onOpenToolAccess?: (serverName: string) => void;
};

export type ChatComposerPlusMenuContentProps = ChatComposerPlusMenuProps &
  ChatComposerCapabilityMenuProps & { showCapabilities: boolean };

export type ChatComposerPlusMenuHandlers = {
  items(): readonly MenuEntry[];
  select(item: MenuItem, event: CustomEvent<MenuItem>): void;
};

export type ChatComposerPlusMenuBodyProps = {
  menu: ChatComposerPlusMenuContentProps;
  view: ChatComposerPlusMenuView;
  readMenu: () => MenuHandle;
  onReady: (handlers: ChatComposerPlusMenuHandlers | undefined) => void;
  renderItems: (items: () => readonly MenuEntry[]) => JSX.Element;
};
