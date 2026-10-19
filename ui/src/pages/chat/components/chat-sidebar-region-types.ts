import type { JSX } from "@solidjs/web";
import type { IconName } from "../../../components/solid/icon.tsx";
import type { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import type { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import type { AgentIdentity } from "../../../lib/identity-avatar-view.ts";
import type { KeyboardShortcutCombo } from "../../../lib/keyboard-shortcut-contract.ts";
import type { SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import type {
  SidebarPanelData,
  SidebarPanelDefinitionParams,
} from "../chat-pane-embedded-types.ts";
import type { LinkFaviconFetcher } from "../link-favicon-cache.ts";
import type { SidebarLayout, SidebarSlotId } from "../sidebar-layout.ts";

export type SidebarPanelDefinition = {
  slot: SidebarSlotId;
  label: string;
  icon: IconName;
  shortcut?: KeyboardShortcutCombo;
  available: boolean;
  content: JSX.Element;
  /** Explicit host for caller-owned panel content. */
  panelHost?: SidebarPanelHost;
  view?: SidebarPanelData;
  loadState?: Parameters<typeof LazyViewError>[0] | null;
  loading: Parameters<typeof PanelLoadingSkeleton>[0];
  headerActionView?: SidebarPanelDefinitionParams;
  headerLink?: { href: string; label: string };
  empty: {
    description: string;
    action?: JSX.Element;
  };
};

export type SidebarRegionCallbacks = {
  activatePanel: (panelId: string) => void;
  togglePanelExpanded: (panelId: string) => void;
  closeSlot: (slot: SidebarSlotId) => void;
  openSlot: (slot: SidebarSlotId) => void;
  reorderPanel: (panelId: string, targetPanelId: string, placement: "before" | "after") => void;
  resizePanel: (columnId: string, size: number) => void;
  setOpen: (open: boolean) => void;
};

export type RegionProps = {
  elements: {
    readonly shell: HTMLElement;
    readonly header: HTMLElement;
    readonly primary: HTMLElement;
    readonly outlet: HTMLElement;
  } | null;
  panelIdPrefix: string;
  conversationTab?: Pick<SidebarPanelDefinition, "label"> & {
    avatar: AgentIdentity;
  };
  layout: SidebarLayout;
  panelDefinitions: SidebarPanelDefinition[];
  fetchFavicon?: LinkFaviconFetcher;
  callbacks: SidebarRegionCallbacks | null;
  narrow: boolean;
  sideFocusLocked: boolean;
  sideFocusManaged?: boolean;
  sideFocusOrigin?: () => HTMLElement | null;
  availableWidth: number;
};
export type SidebarPanelHost = HTMLElement & {
  readonly updateComplete?: Promise<unknown>;
  handleToggleRequest?: (event: Event) => void;
  activateTerminalHost?: () => void;
};
export type SidebarPanelHostRegistration = (element: SidebarPanelHost) => () => void;
export type RegionMethods = {
  readPanelHost: (slot: SidebarSlotId) => SidebarPanelHost | null;
  awaitPanelCommit: (slot: SidebarSlotId) => Promise<void>;
  activateTerminalHost: () => boolean;
  focusActiveSideTab: (options?: FocusOptions) => void;
  deliverPanelEvent: (slot: SidebarSlotId, event: Event) => boolean;
};
export type RegionElement = SolidBridgeElement<RegionProps, RegionMethods>;
