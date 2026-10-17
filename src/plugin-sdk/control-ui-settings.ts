import type { ControlUiSettingsPlacement } from "../../packages/gateway-protocol/src/plugin-control-ui-settings.js";
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
  readonly placement: ControlUiSettingsPlacement;
  mount: (
    container: HTMLElement,
    context: ControlUiSettingsContext,
  ) => {
    update: (props: ControlUiSettingsSnapshot) => void;
    dispose: () => void;
  };
};
