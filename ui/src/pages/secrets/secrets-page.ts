import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { ENV_SECRET_REF_ID_RE } from "../../../../src/config/types.secrets.js";
import { isSensitiveEnvName } from "../../../../src/secrets/secret-env-name.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  bulkSetSecretsStoreEntries,
  createInitialSecretsStoreState,
  deleteSecretsStoreEntry,
  loadSecretsStore,
  parseSecretsStoreBulkInput,
  setSecretsStoreEntry,
  type SecretsStoreDraft,
  type SecretsStoreState,
} from "../../lib/secrets-store/index.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderSecretsStore, type SecretsDialogMode } from "./view.ts";

const MAX_VALUE_BYTES = 64 * 1024;

class SecretsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private store = createInitialSecretsStoreState();
  @state() private dialogMode: SecretsDialogMode = null;
  @state() private draft: SecretsStoreDraft = {
    name: "",
    value: "",
    kind: "env",
    allowedHosts: "",
  };
  @state() private secretKindOverridden = false;
  @state() private bulkOpen = false;
  @state() private bulkRaw = "";
  @state() private bulkAutoDetect = true;
  @state() private formError: string | null = null;
  @state() private notice: string | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: (change) => this.resetGatewayState(change.snapshot),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetGatewayState(change.snapshot);
      }
    },
    ensureInitialData: () => this.ensureInitialData(),
  });

  private resetGatewayState(snapshot?: ApplicationContext["gateway"]["snapshot"]) {
    this.store = createInitialSecretsStoreState({
      client: snapshot?.client ?? null,
      connected: snapshot?.phase === "connected",
    });
    this.dialogMode = null;
    this.bulkOpen = false;
    this.formError = null;
    this.notice = null;
  }

  private canCall(method: "secrets.store.list" | "secrets.store.set" | "secrets.store.delete") {
    return canCallGatewayMethod(this.gateway.snapshot, method, "operator.admin");
  }

  private ensureInitialData() {
    if (this.canCall("secrets.store.list") && !this.store.loaded && !this.store.loading) {
      void this.runStoreTask(loadSecretsStore);
    }
  }

  private async runStoreTask(task: (store: SecretsStoreState) => Promise<unknown>): Promise<void> {
    const store = this.store;
    try {
      const result = task(store);
      this.requestUpdate();
      await result;
    } finally {
      if (this.store === store) {
        this.requestUpdate();
      }
    }
  }

  private openEntry(entry?: (typeof this.store.entries)[number]) {
    if (!this.canCall("secrets.store.set")) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.secretKindOverridden = Boolean(entry);
    this.draft = entry
      ? {
          name: entry.name,
          value: entry.kind === "env" ? entry.value : "",
          kind: entry.kind,
          allowedHosts: entry.kind === "secret" ? (entry.allowedHosts ?? []).join("\n") : "",
        }
      : { name: "", value: "", kind: "env", allowedHosts: "" };
    this.dialogMode = entry ? "edit" : "add";
  }

  private closeDialog(bulk = false) {
    if (!this.store.busy) {
      if (bulk) {
        this.bulkOpen = false;
      } else {
        this.dialogMode = null;
      }
      this.formError = null;
    }
  }

  private patchDraft(patch: Partial<SecretsStoreDraft>) {
    this.draft = { ...this.draft, ...patch };
    this.formError = null;
  }

  private changeDraftName(name: string) {
    const normalized = name.toUpperCase();
    this.patchDraft({
      name: normalized,
      ...(!this.secretKindOverridden
        ? { kind: isSensitiveEnvName(normalized) ? ("secret" as const) : ("env" as const) }
        : {}),
    });
  }

  private validateValue(value: string, kind: SecretsStoreDraft["kind"]): string | null {
    if (kind === "secret" && value.length === 0) {
      return t("secretsStore.required");
    }
    if (new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) {
      return t("secretsStore.tooLarge");
    }
    return null;
  }

  private saveEntryTask<Result extends { warningCount?: number }>(
    save: (store: SecretsStoreState) => Promise<Result | null>,
    finish: (result: Result) => string,
  ) {
    void this.runStoreTask(async (store) => {
      const result = await save(store);
      if (this.store !== store) {
        return;
      }
      if (!result) {
        this.formError = store.error;
        return;
      }
      const saved = finish(result);
      this.formError = null;
      this.notice = result.warningCount
        ? `${saved} ${t("secretsStore.warnings", { count: String(result.warningCount) })}`
        : saved;
    });
  }

  private submitDraft() {
    if (!this.canCall("secrets.store.set") || !this.dialogMode) {
      return;
    }
    const error = ENV_SECRET_REF_ID_RE.test(this.draft.name)
      ? this.validateValue(this.draft.value, this.draft.kind)
      : t("secretsStore.badName");
    if (error) {
      this.formError = error;
      return;
    }
    const draft = { ...this.draft };
    this.saveEntryTask(
      (store) => setSecretsStoreEntry(store, draft),
      () => {
        this.dialogMode = null;
        return t(
          draft.kind === "secret" ? "secretsStore.savedProtected" : "secretsStore.savedReadable",
          { name: draft.name },
        );
      },
    );
  }

  private openBulk() {
    if (!this.canCall("secrets.store.set")) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.bulkRaw = "";
    this.bulkAutoDetect = true;
    this.bulkOpen = true;
  }

  private get bulkParsed() {
    return parseSecretsStoreBulkInput(this.bulkRaw, this.bulkAutoDetect);
  }

  private submitBulk() {
    if (!this.canCall("secrets.store.set") || !this.bulkOpen) {
      return;
    }
    const parsed = this.bulkParsed;
    if (parsed.invalidNames.length > 0) {
      this.formError = `${t("secretsStore.badName")} ${parsed.invalidNames.join(", ")}`;
      return;
    }
    if (parsed.entries.length === 0) {
      this.formError = t("secretsStore.required");
      return;
    }
    for (const entry of parsed.entries) {
      const error = this.validateValue(entry.value, entry.kind);
      if (error) {
        this.formError = `${entry.name}: ${error}`;
        return;
      }
    }
    this.saveEntryTask(
      (store) => bulkSetSecretsStoreEntries(store, parsed.entries),
      (result) => {
        this.bulkOpen = false;
        return t("secretsStore.savedMany", {
          count: String(result.saved),
          protected: String(parsed.entries.filter((entry) => entry.kind === "secret").length),
          readable: String(parsed.entries.filter((entry) => entry.kind === "env").length),
        });
      },
    );
  }

  private async removeEntry(entry: (typeof this.store.entries)[number]) {
    // A confirmation belongs to the client that opened it. Same-client reconnects remain valid,
    // but a replacement client must never inherit this destructive action.
    const gateway = this.context.gateway;
    const client = this.store.client;
    if (
      !client ||
      !this.canCall("secrets.store.delete") ||
      !(await showConfirmDialog({
        title: t("common.delete"),
        message: t("secretsStore.confirmDelete", { name: entry.name }),
        confirmLabel: t("common.delete"),
        danger: true,
      }))
    ) {
      return;
    }
    this.notice = null;
    if (
      this.context.gateway !== gateway ||
      this.store.client !== client ||
      !this.canCall("secrets.store.delete")
    ) {
      this.store.error = t("secretsStore.deleteFailed");
      this.requestUpdate();
      return;
    }
    await this.runStoreTask(async (store) => {
      const result = await deleteSecretsStoreEntry(store, entry.name);
      if (result && this.store === store) {
        this.notice = t("secretsStore.deleted", { name: entry.name });
      }
    });
  }

  override render() {
    const parsed = this.bulkParsed;
    const body = renderSecretsStore({
      entries: this.store.entries,
      loading: this.store.loading,
      busy: this.store.busy,
      error: this.store.error,
      notice: this.notice,
      canList: this.canCall("secrets.store.list"),
      canSet: this.canCall("secrets.store.set"),
      canDelete: this.canCall("secrets.store.delete"),
      dialogMode: this.dialogMode,
      draft: this.draft,
      formError: this.formError,
      bulkOpen: this.bulkOpen,
      bulkRaw: this.bulkRaw,
      bulkAutoDetect: this.bulkAutoDetect,
      bulkSecretCount: parsed.entries.filter((entry) => entry.kind === "secret").length,
      bulkEntryCount: parsed.entries.length,
      bulkInvalidNames: parsed.invalidNames,
      onRefresh: () => {
        if (this.canCall("secrets.store.list")) {
          void this.runStoreTask(loadSecretsStore);
        }
      },
      onOpenAdd: () => this.openEntry(),
      onOpenEdit: (entry) => this.openEntry(entry),
      onCloseDialog: () => this.closeDialog(),
      onDraftNameChange: (name) => this.changeDraftName(name),
      onDraftValueChange: (value) => this.patchDraft({ value }),
      onDraftAllowedHostsChange: (allowedHosts) => this.patchDraft({ allowedHosts }),
      onDraftKindChange: (kind) => {
        this.secretKindOverridden = true;
        this.patchDraft({ kind });
      },
      onSubmitDraft: () => this.submitDraft(),
      onOpenBulk: () => this.openBulk(),
      onCloseBulk: () => this.closeDialog(true),
      onBulkRawChange: (raw) => {
        this.bulkRaw = raw;
        this.formError = null;
      },
      onBulkAutoDetectChange: (enabled) => {
        this.bulkAutoDetect = enabled;
        this.formError = null;
      },
      onSubmitBulk: () => this.submitBulk(),
      onDelete: (entry) => void this.removeEntry(entry),
    });
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("secrets"),
        subtitle: t("secretsStore.hint"),
      })}
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-secrets-page")) {
  customElements.define("openclaw-secrets-page", SecretsPage);
}
