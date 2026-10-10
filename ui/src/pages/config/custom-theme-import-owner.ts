import type { ApplicationThemeServerSelection } from "../../app/context.ts";
import type { ImportedCustomTheme } from "../../app/custom-theme.ts";
import type { UiSettings } from "../../app/settings.ts";
import type { ThemeName } from "../../app/theme.ts";
import type { RuntimeConfigState } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";

type CustomThemeImportViewState = {
  url: string;
  busy: boolean;
  message: { kind: "success" | "error"; text: string } | null;
  expanded: boolean;
  focusToken: number;
};

export const INITIAL_CUSTOM_THEME_IMPORT_STATE: CustomThemeImportViewState = {
  url: "",
  busy: false,
  message: null,
  expanded: false,
  focusToken: 0,
};

type ImportMessages = {
  blocked: (reason: "loading" | "unsaved") => string;
  imported: (label: string) => string;
};

/** Owns every state transition that can supersede a delayed custom-theme import. */
export class CustomThemeImportOwner {
  private currentImport: object | null = null;
  private activationIntent: { theme: ThemeName | null } = { theme: null };
  private gatewayScope = "";
  private serverSelectionRevision = 0;
  private state = INITIAL_CUSTOM_THEME_IMPORT_STATE;

  constructor(private readonly publish: (state: CustomThemeImportViewState) => void) {}

  get snapshot(): CustomThemeImportViewState {
    return this.state;
  }

  connect(scope: string, serverSelection: ApplicationThemeServerSelection | null): void {
    this.gatewayScope = scope;
    this.serverSelectionRevision = this.selectionForScope(scope, serverSelection)?.revision ?? 0;
  }

  synchronizeScope(scope: string, serverSelection: ApplicationThemeServerSelection | null): void {
    if (this.gatewayScope && scope !== this.gatewayScope) {
      this.retireImport();
    }
    this.connect(scope, serverSelection);
  }

  adoptSettings(
    previous: UiSettings,
    next: UiSettings,
    serverSelection: ApplicationThemeServerSelection | null,
  ): UiSettings {
    const scopedSelection = this.selectionForScope(this.gatewayScope, serverSelection);
    const serverSelectionChanged =
      this.serverSelectionRevision !== (scopedSelection?.revision ?? 0);
    this.serverSelectionRevision = scopedSelection?.revision ?? 0;
    if (next.customTheme?.importedAt !== previous.customTheme?.importedAt) {
      this.retireImport();
      return next;
    }
    // Record every newer selection edge. A later server Custom selection can
    // deliberately re-authorize the palette supplied by an older pending import.
    if (serverSelectionChanged) {
      this.recordActivation(scopedSelection?.theme ?? null);
    }
    if (next.theme !== previous.theme) {
      this.recordActivation(next.theme);
    }
    return next;
  }

  recordActivation(theme: ThemeName | null): void {
    this.activationIntent = { theme };
  }

  open(): void {
    this.update({ expanded: true, focusToken: this.state.focusToken + 1 });
  }

  setUrl(url: string): void {
    if (url !== this.state.url) {
      this.retireImport();
    }
    this.update({
      url,
      ...(this.state.message?.kind === "error" ? { message: null } : {}),
    });
  }

  retireForConfigMutation(message: string): void {
    if (!this.state.busy) {
      return;
    }
    this.retireImport();
    this.update({ message: { kind: "error", text: message } });
  }

  async import(params: {
    config: RuntimeConfigState;
    hasCustomTheme: boolean;
    load: (url: string) => Promise<ImportedCustomTheme>;
    apply: (theme: ImportedCustomTheme, activate: boolean) => void;
    messages: ImportMessages;
  }): Promise<void> {
    const blockedReason = this.blockedReason(params.config);
    if (blockedReason) {
      this.update({
        expanded: true,
        message: { kind: "error", text: params.messages.blocked(blockedReason) },
      });
      return;
    }
    const ticket = {};
    const activationIntent = this.activationIntent;
    this.currentImport = ticket;
    const importUrl = this.state.url;
    this.update({ expanded: true, busy: true, message: null });
    try {
      const theme = await params.load(importUrl);
      if (this.currentImport !== ticket) {
        return;
      }
      params.apply(
        theme,
        !params.hasCustomTheme &&
          (this.activationIntent === activationIntent || this.activationIntent.theme === "custom"),
      );
      this.update({
        url: "",
        message: { kind: "success", text: params.messages.imported(theme.label) },
      });
    } catch (error) {
      if (this.currentImport !== ticket) {
        return;
      }
      this.update({
        message: {
          kind: "error",
          text: formatUiError(error),
        },
      });
    } finally {
      if (this.currentImport === ticket) {
        this.update({ busy: false });
      }
    }
  }

  clear(params: { apply: () => void; message: string }): void {
    this.retireImport();
    params.apply();
    this.update({ expanded: true, message: { kind: "success", text: params.message } });
  }

  retireImport(): void {
    this.currentImport = null;
    if (this.state.busy) {
      this.update({ busy: false });
    }
  }

  private blockedReason(config: RuntimeConfigState): "loading" | "unsaved" | null {
    if (config.connected && (config.configLoading || !config.configSnapshot)) {
      return "loading";
    }
    return config.configFormDirty ||
      config.configSaving ||
      config.configApplying ||
      config.configAutoSaveStatus === "saving"
      ? "unsaved"
      : null;
  }

  private update(patch: Partial<CustomThemeImportViewState>): void {
    this.state = { ...this.state, ...patch };
    this.publish(this.state);
  }

  private selectionForScope(
    scope: string,
    serverSelection: ApplicationThemeServerSelection | null,
  ): ApplicationThemeServerSelection | null {
    return serverSelection?.scope === scope ? serverSelection : null;
  }
}
