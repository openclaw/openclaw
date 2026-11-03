import type { ControlUiSettingsPlacement as AnyControlUiSettingsPlacement } from "../../packages/gateway-protocol/src/plugin-control-ui-settings.js";
import type { ChannelsStatusResult } from "../../packages/gateway-protocol/src/schema/channels.js";
import type { ControlUiComponentHandle } from "./control-ui-components.js";

export type { AnyControlUiSettingsPlacement };
export type ControlUiSettingsPlacement = Extract<
  AnyControlUiSettingsPlacement,
  { section: "memory" | "channels" }
>;
export type ControlUiContributionSettingsPlacement = Extract<
  AnyControlUiSettingsPlacement,
  { section: "profile" | "agents" }
>;
export type ControlUiSettingsSnapshot = {
  readonly agentId: string | null;
  readonly agentsLoading: boolean;
  readonly agentsError: string | null;
  readonly engine: {
    readonly kind: "default" | "off" | "pinned";
    readonly id: string | null;
    readonly availability: "enabled" | "disabled" | "missing" | "loading" | "unknown";
  };
  readonly connected: boolean;
  /** Gateway-advertised methods; absent until the connection publishes its catalog. */
  readonly advertisedMethods?: readonly string[];
  readonly connectionEpoch: number;
  readonly routeIntent: string;
  readonly locale: string;
};

/** General contribution facts do not require a Memory engine. */
export type ControlUiContributionSettingsSnapshot = Omit<ControlUiSettingsSnapshot, "engine"> & {
  /** Hello authorization can settle before the authenticated profile lookup. */
  readonly permissionsReady?: boolean;
  readonly profile?: { readonly id: string } | null;
  readonly canRead?: boolean;
  readonly canAdmin?: boolean;
  readonly agents?: readonly { id: string; name?: string; identity?: { name?: string } }[];
  readonly configAvailable: boolean;
};

export type ControlUiSettingsClient = {
  request: <T = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<T>;
};
export type ControlUiSettingsConfigMutation = <T>(
  task: (client: ControlUiSettingsClient) => Promise<T>,
  options?: {
    canDispatch?: () => boolean;
    dispatchError?: string;
    shouldRefresh?: (value: T) => boolean;
  },
) => Promise<
  | { ok: true; value: T; refresh: { ok: true } | { ok: false; error: string } }
  | {
      ok: false;
      reason: "conflict" | "error" | "rejected" | "suspended" | "unavailable";
      error: string;
    }
>;

type Content = string | HTMLElement;
type SectionProps = { title: string; content: HTMLElement };
type ContributionSectionProps = {
  title: Content;
  description?: Content;
  actions?: Content;
  danger?: boolean;
  content: HTMLElement;
};
type RowProps = { title: string; description?: Content; control?: Content };
type ContributionRowProps = Omit<RowProps, "title"> & { title: Content };
type DetailsRowProps = ContributionRowProps & {
  detailsLabel: string;
  hasDetails?: boolean;
  content: HTMLElement;
};
type DisclosureProps = { title: Content; quiet?: boolean; content: HTMLElement };
type SectionHelpProps = { id: string; section: string; content: HTMLElement };
type StatusProps = { kind: "ok" | "warn" | "danger" | "accent" | "muted"; label: string };
type ValueProps = { value: string | number; mono?: boolean };
type NavProps = { title: string; onClick: () => void };
type SecretInputProps = {
  ariaLabel: string;
  value: string;
  placeholder?: string;
  visible: boolean;
  disabled?: boolean;
  showLabel: string;
  hideLabel: string;
  toggleLabel: string;
  onInput: (value: string) => void;
  onToggle: () => void;
};
type SegmentedProps = {
  value: string;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
  ariaLabel?: string;
  onChange: (value: string) => void;
};
type PetProps = {
  seed: string;
  sleeping?: boolean;
  reading?: boolean;
  grumpy?: boolean;
  standalone?: boolean;
};

/** Consumed by Settings presentations; the shipped ControlUiComponents contract is unchanged. */
export type ControlUiSettingsComponents = {
  mountSection: (
    container: HTMLElement,
    props: SectionProps,
  ) => ControlUiComponentHandle<SectionProps>;
  mountRow: (container: HTMLElement, props: RowProps) => ControlUiComponentHandle<RowProps>;
  mountStatus: (
    container: HTMLElement,
    props: StatusProps,
  ) => ControlUiComponentHandle<StatusProps>;
  mountValue: (container: HTMLElement, props: ValueProps) => ControlUiComponentHandle<ValueProps>;
  mountNavigation: (container: HTMLElement, props: NavProps) => ControlUiComponentHandle<NavProps>;
  mountLobster: (container: HTMLElement, props: PetProps) => ControlUiComponentHandle<PetProps>;
};

export type ControlUiSettingsComponentsV2 = Omit<
  ControlUiSettingsComponents,
  "mountSection" | "mountRow"
> & {
  mountSection: (
    container: HTMLElement,
    props: ContributionSectionProps,
  ) => ControlUiComponentHandle<ContributionSectionProps>;
  mountRow: (
    container: HTMLElement,
    props: ContributionRowProps,
  ) => ControlUiComponentHandle<ContributionRowProps>;
  /** Native disclosure state and overlays belong to the mounted Settings control. */
  mountDetailsRow: (
    container: HTMLElement,
    props: DetailsRowProps,
  ) => ControlUiComponentHandle<DetailsRowProps>;
  mountDisclosure: (
    container: HTMLElement,
    props: DisclosureProps,
  ) => ControlUiComponentHandle<DisclosureProps>;
  mountSectionHelp: (
    container: HTMLElement,
    props: SectionHelpProps,
  ) => ControlUiComponentHandle<SectionHelpProps>;
  mountSecretInput: (
    container: HTMLElement,
    props: SecretInputProps,
  ) => ControlUiComponentHandle<SecretInputProps>;
  mountSegmented: (
    container: HTMLElement,
    props: SegmentedProps,
  ) => ControlUiComponentHandle<SegmentedProps>;
  mountIcon: (
    container: HTMLElement,
    props: { name: "copy" },
  ) => ControlUiComponentHandle<{ name: "copy" }>;
};

export type ControlUiSettingsContext = {
  readonly signal: AbortSignal;
  readonly props: ControlUiSettingsSnapshot;
  readonly components: ControlUiSettingsComponents;
  /** Existing authenticated operator RPC authority, bound to this Settings lifetime. */
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  navigate: (destination: "overview" | "memories" | "dreams" | "settings") => void;
  refreshAgents: () => void;
  formatRelativeTimestamp: (timestamp: number) => string;
  formatError: (error: unknown) => string;
};

/** New Settings contributions opt in to required mutation and presentation capabilities. */
export type ControlUiSettingsContextV2 = Omit<ControlUiSettingsContext, "props" | "components"> & {
  readonly apiVersion: 2;
  readonly props: ControlUiContributionSettingsSnapshot;
  readonly components: ControlUiSettingsComponentsV2;
  request: ControlUiSettingsClient["request"];
  readConfig: (path: readonly string[]) => unknown;
  registerEnglish: (catalog: Record<string, Record<string, string>>) => void;
  /** Read through a mounted Settings owner's current snapshot. */
  projectOwner: <T>(source: { read: () => T; subscribe: (notify: () => void) => () => void }) => {
    read: () => T;
    dispose: () => void;
  };
  copyButton: (
    event: Event,
    text: string,
    idleLabel: string,
    targets: { label?: HTMLElement; feedback?: HTMLElement; announcement?: HTMLElement },
  ) => Promise<boolean>;
  navigateTo: (destination: { page: "profile" | "agent-tools"; hash?: string }) => void;
  /** The config owner serializes and refreshes an external config mutation. */
  runConfigMutation: ControlUiSettingsConfigMutation;
  ensureConfig: () => Promise<void>;
  confirm: (options: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
  translate: (key: string, params?: Record<string, string>) => string;
  formatExternalText: (value: string | null | undefined, fallback?: string) => string;
  formatDateTime: (timestamp: number, options?: Intl.DateTimeFormatOptions) => string;
};

export type ControlUiSettingsView = {
  readonly placement: Extract<ControlUiSettingsPlacement, { section: "memory" }>;
  mount: (
    container: HTMLElement,
    context: ControlUiSettingsContext,
  ) => {
    update: (props: ControlUiSettingsSnapshot) => void;
    dispose: () => void;
  };
};

export type ControlUiContributedSettingsView = {
  readonly placement: ControlUiContributionSettingsPlacement;
  mount: (
    container: HTMLElement,
    context: ControlUiSettingsContextV2,
  ) => {
    update: (props: ControlUiContributionSettingsSnapshot) => void;
    dispose: () => void;
  };
};

export type ControlUiChannelSettingsSnapshot = {
  readonly channelId: string;
  readonly status: unknown;
  readonly defaultAccountId?: string;
  readonly login?: {
    readonly message: string | null;
    readonly qrDataUrl: string | null;
    readonly connected: boolean | null;
    readonly busy: boolean;
  };
  readonly accounts: readonly ChannelsStatusResult["channelAccounts"][string][number][];
  readonly connected: boolean;
  readonly canAdmin: boolean;
  readonly connectionEpoch: number;
  readonly locale: string;
  /** Detaching the channel detail does not end this page-owned editor lifetime. */
  readonly presented: boolean;
};

export type ControlUiChannelSettingsContext = {
  readonly signal: AbortSignal;
  readonly props: ControlUiChannelSettingsSnapshot;
  readonly components: ControlUiSettingsComponents;
  /** Authenticated JSON under this channel's account namespace; no credentials leave the host. */
  request: (request: {
    accountId: string;
    path: readonly string[];
    method: "PUT" | "POST";
    body: unknown;
    signal: AbortSignal;
  }) => Promise<{
    ok: boolean;
    status: number;
    data: Record<string, unknown> | null;
    errorMessage: string;
  }>;
  /** Shared login owner, available only for the declaring channel's existing login flow. */
  login?: {
    start: (force: boolean) => Promise<void>;
    wait: () => Promise<void>;
    /** Capture the current account before an awaited operator decision. */
    captureLogout: () => { readonly accountId: string; logout: () => Promise<void> } | null;
  };
  confirm?: (options: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
  }) => Promise<boolean>;
  formatPhoneNumber?: (value: string) => string;
  formatDuration?: (milliseconds: number) => string;
  mountConfig: (container: HTMLElement) => () => void;
  refresh: (probe: boolean) => Promise<void>;
  formatRelativeTimestamp: (timestamp: number | null | undefined) => string;
  formatError: (error: unknown) => string;
  formatExternalText: (text: string) => string;
};

export type ControlUiChannelSettingsView = {
  readonly placement: Extract<ControlUiSettingsPlacement, { section: "channels" }>;
  mount: (
    container: HTMLElement,
    context: ControlUiChannelSettingsContext,
  ) => {
    update: (props: ControlUiChannelSettingsSnapshot) => void;
    dispose: () => void;
  };
};
