import type { ControlUiComponentHandle } from "./control-ui-components.js";
import type { ControlUiLinkReaderPreview } from "./control-ui-link-reader.js";
export type ControlUiTranslationMap = { readonly [key: string]: string | ControlUiTranslationMap };
export type ControlUiToggleProps = {
  checked: boolean;
  disabled?: boolean;
  /** Block activation during a save without removing keyboard focus. */
  saving?: boolean;
  ariaLabel: string;
  inputRef?: (element: HTMLInputElement) => void;
  onChange: (checked: boolean) => boolean | void;
};
export type ControlUiIconProps = { name: string; className?: string };
export type ControlUiMarqueeOptions = {
  delay?: number;
  speed?: number;
  loop?: boolean;
  host?: () => HTMLElement | undefined;
  stationary?: boolean;
  stationaryWithoutHost?: boolean;
};
export type ControlUiMenuControls = {
  readonly elements: ReadonlySet<HTMLElement>;
  ref(this: void): (element: HTMLElement) => void;
};
export type ControlUiMenuHandle = {
  readonly overlay: { readonly trigger: HTMLElement | undefined; readonly open: boolean };
  open: () => boolean;
  close: () => boolean;
  focusFirst: () => void;
  itemElement: (id: string) => HTMLElement | undefined;
};
/** Host-owned attributes are forwarded unchanged to the plugin-rendered root control. */
export type ControlUiMenuItemAttributes = object;
export type ControlUiMenuEntry =
  | { kind: "content"; id: string; content: HTMLElement }
  | { kind: "group"; id: string; className?: string; items: readonly ControlUiMenuEntry[] }
  | {
      kind?: "item";
      id: string;
      label: string;
      className?: string;
      type?: "radio" | "checkbox";
      checked?: boolean;
      disabled?: boolean;
      content?: HTMLElement;
      details?: HTMLElement;
      icon?: HTMLElement;
      href?: string;
      attributes?: {
        target?: string;
        rel?: string;
        [name: `data-${string}`]: string | number | boolean | undefined;
      };
      closeOnSelect?: boolean;
      variant?: "danger";
      render?: (attributes: ControlUiMenuItemAttributes) => HTMLElement;
    };
export type ControlUiMenuProps = {
  id: string;
  className?: string;
  panelClass?: string;
  placement?: "top-end" | "bottom-end";
  label: string;
  disabled?: boolean;
  triggerClass?: string;
  triggerAttributes?: { [name: `data-${string}`]: string | undefined };
  trigger: HTMLElement;
  content?: HTMLElement;
  controls?: ControlUiMenuControls;
  items: readonly ControlUiMenuEntry[];
  presented: boolean;
  ref?: (handle: ControlUiMenuHandle) => void;
  onBeforeShow?: (event: Event) => void;
  onOpenChange?: (open: boolean) => void;
  onEscape?: () => boolean;
  onSelect: (id: string) => void;
};
export type ControlUiActivityPillView = {
  label: string;
  icon: string;
  tone?: "normal" | "muted" | "ok" | "warn" | "danger" | "purple";
  badge?: {
    icon: string;
    tone: "normal" | "muted" | "ok" | "warn" | "danger" | "purple";
    label: string;
  };
  attention?: boolean;
  shine?: boolean;
  count?: string;
  description?: string;
};
export type ControlUiActivityPillProps = {
  family: string;
  view: ControlUiActivityPillView;
  onOpen: (source: HTMLButtonElement) => void;
  registerButton: (button: HTMLButtonElement) => () => void;
  trailing?: HTMLElement;
};
/** Snapshot seeds improve display immediately; native reader admission still owns enrichment. */
export type ControlUiLinkPreviewsProps = {
  child: HTMLElement;
  previewSeeds: readonly ControlUiLinkReaderPreview[];
  sessionKey?: string;
  agentId?: string;
};
export type ControlUiLazyStateProps =
  | { status: "loading" }
  | { status: "error"; error: unknown; onRetry: () => void; isCurrent: () => boolean };
/** Shared visual controls and locale services, scoped to one native UI owner. */
export type ControlUiPresentationHost = {
  readonly apiVersion: 1;
  formatError: (error: unknown, fallback?: string) => string;
  formatDuration: (ms?: number | null) => string | undefined;
  safeExternalUrl: (value: string, base: string) => string | null;
  subscribe: (listener: () => void) => () => void;
  /** Public catalog lookup remains usable after view or activation retirement. */
  translate: (key: string, params?: Record<string, string>) => string;
  registerEnglish: (catalog: ControlUiTranslationMap) => void;
  /** Existing native loading/error presentation and guarded stale-asset recovery. */
  mountLazyState: (
    container: HTMLElement,
    props: ControlUiLazyStateProps,
  ) => ControlUiComponentHandle<ControlUiLazyStateProps>;
  /** Use the host's current connection, reader catalog, cache, and hover/focus lifecycle. */
  mountLinkPreviews: (
    container: HTMLElement,
    props: ControlUiLinkPreviewsProps,
  ) => ControlUiComponentHandle<ControlUiLinkPreviewsProps>;
  mountActivityPill: (
    container: HTMLElement,
    props: ControlUiActivityPillProps,
  ) => ControlUiComponentHandle<ControlUiActivityPillProps>;
  mountToggle: (
    container: HTMLElement,
    props: ControlUiToggleProps,
  ) => ControlUiComponentHandle<ControlUiToggleProps>;
  mountIcon: (
    container: HTMLElement,
    props: ControlUiIconProps,
  ) => ControlUiComponentHandle<ControlUiIconProps>;
  mountMenu: (
    container: HTMLElement,
    props: ControlUiMenuProps,
  ) => ControlUiComponentHandle<ControlUiMenuProps>;
  /** Shared clipped-text behavior; the plugin retains the element and its copy. */
  mountTextOverflow: (
    element: HTMLElement,
    props: { content: unknown },
  ) => ControlUiComponentHandle<{ content: unknown }>;
  copyText: (value: string, isCurrent: () => boolean) => Promise<boolean>;
  notify: (message: string) => void;
  mountMarquee: (
    container: HTMLElement,
    props: { content: HTMLElement; className: string; options: ControlUiMarqueeOptions },
  ) => ControlUiComponentHandle<{
    content: HTMLElement;
    className: string;
    options: ControlUiMarqueeOptions;
  }>;
  mountTooltip: (
    container: HTMLElement,
    props: { content: string; child: HTMLElement; disabled?: boolean },
  ) => ControlUiComponentHandle<{ content: string; child: HTMLElement; disabled?: boolean }>;
};
