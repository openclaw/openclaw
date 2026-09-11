import type { BoardGetParams } from "@openclaw/gateway-protocol";

/** Semantic host components available to native Control UI plugins. */
export type ControlUiComponentHandle<T> = {
  update: (props: T) => void;
  dispose: () => void;
};

export type ControlUiDialogProps = {
  label: string;
  description?: string;
  className?: string;
  style?: string;
  /** The plugin retains rendering ownership of this node. */
  content: HTMLElement;
  returnFocusTarget?: HTMLElement | null;
  /** Returning false keeps the dialog open, for example during a pending save. */
  onCancel: () => boolean | void;
};

export type ControlUiAgentAvatarProps = {
  agentId: string;
  label: string;
};

export type ControlUiAgentPickerProps = {
  options: readonly {
    value: string;
    label: string;
    description?: string;
    badge?: string;
    disabled?: boolean;
    agent?: { id: string };
    icon?: "bot" | "users";
  }[];
  value: string;
  placeholder?: string;
  accessibleLabel: string;
  menuLabel?: string;
  variant?: "default" | "compact";
  disabled?: boolean;
  onSelect: (value: string) => void;
};

export type ControlUiSessionSummaryProps = {
  session: BoardGetParams;
  presented: boolean;
};

export type ControlUiDashboardProps = {
  session: BoardGetParams;
  canMutate: boolean;
  canGrant: boolean;
  presented?: boolean;
};

export type ControlUiSelectPickerProps = {
  options: readonly {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
  }[];
  value: string;
  accessibleLabel: string;
  searchable?: boolean;
  disabled?: boolean;
  onSelect: (value: string) => void;
};

export type ControlUiAppearanceGlyphProps = {
  icon: string | null;
  color: string | null;
  fallback: string;
};

export type ControlUiAppearancePickerProps = {
  icon: string | null;
  color: string | null;
  disabled?: boolean;
  /** Disable clearing when the owner's existing storage contract requires a value. */
  clearable?: boolean;
  onChange: (appearance: { icon: string | null; color: string | null }) => void;
};

export type ControlUiComponents = {
  mountAgentAvatar: (
    container: HTMLElement,
    props: ControlUiAgentAvatarProps,
  ) => ControlUiComponentHandle<ControlUiAgentAvatarProps>;
  mountAppearancePicker: (
    container: HTMLElement,
    props: ControlUiAppearancePickerProps,
  ) => ControlUiComponentHandle<ControlUiAppearancePickerProps>;
  mountAppearanceGlyph: (
    container: HTMLElement,
    props: ControlUiAppearanceGlyphProps,
  ) => ControlUiComponentHandle<ControlUiAppearanceGlyphProps>;
  mountDialog: (
    container: HTMLElement,
    props: ControlUiDialogProps,
  ) => ControlUiComponentHandle<ControlUiDialogProps>;
  mountAgentPicker: (
    container: HTMLElement,
    props: ControlUiAgentPickerProps,
  ) => ControlUiComponentHandle<ControlUiAgentPickerProps>;
  mountSelectPicker: (
    container: HTMLElement,
    props: ControlUiSelectPickerProps,
  ) => ControlUiComponentHandle<ControlUiSelectPickerProps>;
  mountSessionSummary: (
    container: HTMLElement,
    props: ControlUiSessionSummaryProps,
  ) => ControlUiComponentHandle<ControlUiSessionSummaryProps>;
  mountDashboard: (
    container: HTMLElement,
    props: ControlUiDashboardProps,
  ) => ControlUiComponentHandle<ControlUiDashboardProps>;
};
