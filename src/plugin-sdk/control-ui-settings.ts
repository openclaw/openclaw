import type { ControlUiSettingsPlacement } from "../../packages/gateway-protocol/src/plugin-control-ui-settings.js";
import type { ChannelsStatusResult } from "../../packages/gateway-protocol/src/schema/channels.js";
import type { ControlUiComponentHandle } from "./control-ui-components.js";

export type { ControlUiSettingsPlacement };
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

type Content = string | HTMLElement;
type SectionProps = { title: string; content: HTMLElement };
type RowProps = { title: string; description?: Content; control?: Content };
type StatusProps = { kind: "ok" | "warn" | "danger" | "accent" | "muted"; label: string };
type ValueProps = { value: string | number; mono?: boolean };
type NavProps = { title: string; onClick: () => void };
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
