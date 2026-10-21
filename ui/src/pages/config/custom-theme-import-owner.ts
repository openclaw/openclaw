import type { ImportedCustomTheme } from "../../app/custom-theme.ts";
import type { UiSettings } from "../../app/settings.ts";
import type { ThemeName } from "../../app/theme.ts";
import type { RuntimeConfigState } from "../../lib/config/config-state-model.ts";

type CustomThemeImportViewState = {
  url: string;
  message: { kind: "success" | "error"; text: string } | null;
  expanded: boolean;
  completion?: Promise<void>;
};

type ImportMessages = {
  blocked: (reason: "loading" | "unsaved") => string;
  imported: (label: string) => string;
};

/** Keeps delayed imports scoped to their page and the latest import URL. */
export class CustomThemeImportOwner {
  private currentImport: { resolve: () => void } | null = null;
  private gatewayScope = "";
  private state: CustomThemeImportViewState = {
    url: "",
    message: null,
    expanded: false,
  };

  constructor(private readonly publish: (state: CustomThemeImportViewState) => void) {}

  get snapshot(): CustomThemeImportViewState {
    return this.state;
  }

  get completedImport(): Promise<void> | undefined {
    return this.currentImport ? undefined : this.state.completion;
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
    if (url !== this.state.url || (!this.currentImport && this.state.completion)) {
      this.retireImport();
    }
    this.update({
      url,
      ...(this.state.message?.kind === "error" ? { message: null } : {}),
    });
  }

  retireForConfigMutation(message: string): void {
    if (!this.currentImport) {
      return;
    }
    this.retireImport();
    this.update({ message: { kind: "error", text: message } });
  }

  import(params: {
    config: RuntimeConfigState;
    hasCustomTheme: boolean;
    readTheme: () => ThemeName;
    load: (url: string) => Promise<ImportedCustomTheme>;
    apply: (theme: ImportedCustomTheme, activate: boolean) => void;
    messages: ImportMessages;
  }): Promise<void> | undefined {
    const blockedReason = this.blockedReason(params.config);
    if (blockedReason) {
      this.update({
        expanded: true,
        completion: undefined,
        message: { kind: "error", text: params.messages.blocked(blockedReason) },
      });
      return undefined;
    }
    const ticket = Promise.withResolvers<void>();
    const startingTheme = params.readTheme();
    this.currentImport = ticket;
    const importUrl = this.state.url;
    const completion = (async () => {
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
        throw error;
      } finally {
        if (this.currentImport === ticket) {
          this.currentImport = null;
          this.update({});
        }
      }
    })();
    // Retired transports may settle later; release their presentation immediately.
    const admitted = Promise.race([completion, ticket.promise]);
    this.update({ expanded: true, message: null, completion: admitted });
    return admitted;
  }

  clear(params: { apply: () => void; message: string }): void {
    this.retireImport();
    params.apply();
    this.update({ expanded: true, message: { kind: "success", text: params.message } });
  }

  retireImport(): void {
    if (this.currentImport || this.state.completion) {
      this.currentImport?.resolve();
      this.currentImport = null;
      this.update({ completion: undefined });
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
