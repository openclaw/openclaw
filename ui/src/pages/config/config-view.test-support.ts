import { render } from "lit";
import { vi } from "vitest";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import { createConfigViewState, renderConfig, type ConfigProps } from "./view.ts";

export const baseProps = () => ({
  onAppearanceChange: vi.fn(),
  raw: "{\n}\n",
  originalRaw: "{\n}\n",
  valid: true,
  issues: [],
  loading: false,
  saving: false,
  applying: false,
  updating: false,
  connected: true,
  schema: {
    type: "object",
    properties: {},
  },
  schemaLoading: false,
  uiHints: {},
  formMode: "form" as const,
  viewState: createConfigViewState(),
  showModeToggle: true,
  formValue: {},
  activeSection: null,
  activeSubsection: null,
  onRawChange: vi.fn(),
  onFormModeChange: vi.fn(),
  onViewStateChange: vi.fn(),
  onFormPatch: vi.fn(),
  onFormRemove: vi.fn(),
  onSectionChange: vi.fn(),
  onSave: vi.fn(),
  onRawDiscard: vi.fn(),
  onSubsectionChange: vi.fn(),
  theme: "claw" as ThemeName,
  themeOverridden: false,
  themeProvenance: "default" as const,
  themeResetValue: "claw" as ThemeName,
  themeMode: "system" as ThemeMode,
  themeModeOverridden: false,
  themeModeProvenance: "default" as const,
  themeModeResetValue: "system" as ThemeMode,
  fontUi: undefined,
  fontChat: undefined,
  fontUiProvenance: "default" as const,
  fontChatProvenance: "default" as const,
  setFontUi: vi.fn(),
  setFontChat: vi.fn(),
  accent: undefined,
  accentProvenance: "default" as const,
  accentResetValue: undefined,
  systemLocale: "en" as const,
  localeOverride: undefined,
  localeOverridden: false,
  localeProvenance: "default" as const,
  localeResetValue: undefined,
  onLocaleChange: vi.fn(),
  setTheme: vi.fn(),
  setThemeMode: vi.fn(),
  setAccent: vi.fn(),
  hasCustomTheme: false,
  customThemeLabel: null,
  customThemeSourceUrl: null,
  customThemeImportUrl: "",
  customThemeImportBusy: false,
  customThemeImportMessage: null,
  customThemeImportExpanded: false,
  customThemeImportFocusToken: 0,
  onCustomThemeImportUrlChange: vi.fn(),
  onImportCustomTheme: vi.fn(),
  onClearCustomTheme: vi.fn(),
  onOpenCustomThemeImport: vi.fn(),
  textScale: 100,
  textScaleOverridden: false,
  setTextScale: vi.fn(),
  sidebarLiveActivity: true,
  hiddenSessionCatalogIds: new Set<string>(),
  hiddenSessionCatalogLabels: new Map<string, string>(),
  setSessionCatalogHidden: vi.fn(),
  openLinksExternally: false,
  composerHoldToRecord: true,
  lobsterPetVisits: true,
  lobsterPetSounds: false,
  sessionDeleteConfirm: true,
  terminalFontFamily: undefined,
  setTerminalFontFamily: vi.fn(),
  chatMessageMaxWidth: undefined,
  chatShowTaskProgress: true,
  chatCollapseTaskProgress: false,
  showAdvancedSettings: false,
  chatSendShortcut: "enter" as const,
  chatSendShortcutOverridden: false,
  chatSendShortcutProvenance: "default" as const,
  chatSendShortcutResetValue: "enter" as const,
  chatFollowUpMode: undefined,
  chatFollowUpModeOverridden: false,
  chatFollowUpModeProvenance: "default" as const,
  serverQueueMode: "steer" as const,
  resetChatFollowUpMode: vi.fn(),
  catalogOpenTarget: "viewer" as const,
  gatewayUrl: "",
  assistantName: "OpenClaw",
});

export function renderConfigView(overrides: Partial<ConfigProps> = {}): {
  container: HTMLElement;
  props: ConfigProps;
} {
  const container = document.createElement("div");
  const props = {
    ...baseProps(),
    ...overrides,
  };
  const rerender = () =>
    render(
      renderConfig({
        ...props,
        onViewStateChange: rerender,
      }),
      container,
    );
  rerender();
  return { container, props };
}

export function renderAppearance(overrides: Partial<ConfigProps> = {}) {
  return renderConfigView({
    activeSection: "__appearance__",
    includeSections: ["__appearance__"],
    ...overrides,
  });
}
