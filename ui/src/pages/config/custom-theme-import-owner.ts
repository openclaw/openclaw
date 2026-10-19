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
};

type ImportMessages = {
  blocked: (reason: "loading" | "unsaved") => string;
  imported: (label: string) => string;
};

/** Keeps delayed imports scoped to their page and the latest import URL. */
export class CustomThemeImportOwner {
  private currentImport: object | null = null;
  private gatewayScope = "";
  private state: CustomThemeImportViewState = {
    url: "",
    busy: false,
    message: null,
    expanded: false,
  };

  constructor(private readonly publish: (state: CustomThemeImportViewState) => void) {}

  get snapshot(): CustomThemeImportViewState {
    return this.state;
  }

  connect(scope: string): void {
    this.gatewayScope = scope;
  }

  synchronizeScope(scope: string): void {
    if (this.gatewayScope && scope !== this.gatewayScope) {
      this.retireImport();
    }
    this.connect(scope);
  }

  adoptSettings(previous: UiSettings, next: UiSettings): UiSettings {
    if (next.customTheme?.importedAt !== previous.customTheme?.importedAt) {
      this.retireImport();
    }
    return next;
  }

  open(): void {
    this.update({ expanded: true });
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
    readTheme: () => ThemeName;
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
    const startingTheme = params.readTheme();
    this.currentImport = ticket;
    const importUrl = this.state.url;
    this.update({ expanded: true, busy: true, message: null });
    try {
      const theme = await params.load(importUrl);
      if (this.currentImport !== ticket) {
        return;
      }
      // Equal-valued server selection edges are best effort; the displayed choice wins.
      const currentTheme = params.readTheme();
      params.apply(
        theme,
        !params.hasCustomTheme && (currentTheme === startingTheme || currentTheme === "custom"),
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
}
