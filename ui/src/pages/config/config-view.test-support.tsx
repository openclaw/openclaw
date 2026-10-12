import { createRouter } from "@openclaw/uirouter";
import { createSignal, onCleanup } from "solid-js";
import { vi } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationTheme } from "../../app/context-types.ts";
import { loadSettings } from "../../app/settings.ts";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { Config, createConfigViewState, type ConfigProps } from "./view.tsx";

const views = new WeakMap<HTMLElement, (props: ConfigProps) => void>();

function createViewContext() {
  const { gateway } = createApplicationGateway();
  const router = createRouter<RouteId, ApplicationContext>({ routes: [] });
  const theme: ApplicationTheme = {
    branding: resolveThemeBranding(undefined),
    settings: loadSettings(),
    mode: "system",
    resolvedMode: "light",
    serverSelection: null,
    appliedPalette: null,
    recordServerSelection: () => undefined,
    setMode: () => undefined,
    refresh: () => undefined,
    subscribe: () => () => undefined,
  };
  const context: Pick<ApplicationContext, "gateway" | "theme" | "router"> = {
    gateway,
    theme,
    router,
  };
  // Rendering consumes only Gateway, theme and router capabilities.
  return { context: context as ApplicationContext, router };
}

/** Update one mounted view so the test exercises retained field identity. */
export function renderConfigInto(props: ConfigProps, container: HTMLElement) {
  const update = views.get(container);
  if (update) {
    update({ ...props });
    flush();
    return;
  }
  const [current, setCurrent] = createSignal({ ...props });
  views.set(container, setCurrent);
  const application = createViewContext();
  const provider = createSolidApplicationContextProvider(application.context);
  mountSolid(
    () => {
      onCleanup(() => {
        views.delete(container);
        application.router.stop();
      });
      return <Config {...current()} />;
    },
    { container, wrapper: provider.wrapper },
  );
  flush();
}

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
  tabIcon: undefined,
  setTabIconMode: vi.fn(),
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
  const rerender = () => renderConfigInto({ ...props, onViewStateChange: rerender }, container);
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
