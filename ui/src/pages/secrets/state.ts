import { ENV_SECRET_REF_ID_RE } from "../../../../src/config/types.secrets.js";
import { isSensitiveEnvName } from "../../../../src/secrets/secret-env-name.js";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { t } from "../../lib/reactive/i18n.ts";
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

const MAX_VALUE_BYTES = 64 * 1024;

export class SecretsPageState {
  store = createInitialSecretsStoreState();
  readReceipt: { store: SecretsStoreState; result: Promise<void> } | null = null;
  presentationLifetime = Promise.withResolvers<void>();
  dialogMode: "add" | "edit" | null = null;
  draft: SecretsStoreDraft = {
    name: "",
    value: "",
    kind: "env",
    allowedHosts: "",
  };
  secretKindOverridden = false;
  bulkOpen = false;
  bulkRaw = "";
  bulkAutoDetect = true;
  formError: string | null = null;
  notice: string | null = null;

  readonly lifecycle = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });

  constructor(
    readonly context: ApplicationContext,
    readonly notify: () => void,
  ) {}

  act(action: (state: SecretsPageState) => void) {
    action(this);
    this.notify();
  }

  bindGateway(source: ApplicationContext["gateway"]) {
    this.lifecycle.invalidate();
    this.lifecycle.transition(source.snapshot);
    this.resetGatewayState(source.snapshot);
    // Gateway receipts replace secret request state and close dialogs before old requests can settle.
    const release = source.subscribe((snapshot) => {
      if (this.context.gateway !== source) {
        return;
      }
      if (this.lifecycle.transition(snapshot)) {
        this.resetGatewayState(snapshot);
        this.ensureInitialData();
      }
      this.notify();
    });
    this.ensureInitialData();
    this.notify();
    return () => {
      release();
      this.lifecycle.invalidate();
      this.resetGatewayState();
    };
  }

  dispose() {
    this.lifecycle.dispose();
    this.resetGatewayState();
  }

  retirePresentation() {
    this.presentationLifetime.resolve();
    this.presentationLifetime = Promise.withResolvers<void>();
  }

  resetGatewayState(snapshot?: ApplicationContext["gateway"]["snapshot"]) {
    this.retirePresentation();
    this.readReceipt = null;
    this.store = createInitialSecretsStoreState({
      client: snapshot?.client ?? null,
      connected: snapshot?.phase === "connected",
    });
    this.dialogMode = null;
    this.bulkOpen = false;
    this.formError = null;
    this.notice = null;
  }

  canCall(method: "secrets.store.list" | "secrets.store.set" | "secrets.store.delete") {
    return canCallGatewayMethod(this.context.gateway.snapshot, method, "operator.admin");
  }

  ensureInitialData() {
    if (this.canCall("secrets.store.list") && !this.store.loaded && !this.store.loading) {
      this.reload();
    }
  }

  reload() {
    if (!this.canCall("secrets.store.list") || this.store.loading) {
      return;
    }
    this.readReceipt = { store: this.store, result: this.runStoreTask(loadSecretsStore) };
    this.notify();
  }

  async runStoreTask(task: (store: SecretsStoreState) => Promise<unknown>): Promise<void> {
    const store = this.store;
    try {
      const result = task(store);
      this.notify();
      await result;
    } finally {
      if (this.store === store) {
        this.notify();
      }
    }
  }

  openEntry(entry?: (typeof this.store.entries)[number]) {
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

  closeDialog(bulk = false) {
    if (!this.store.busy) {
      if (bulk) {
        this.bulkOpen = false;
      } else {
        this.dialogMode = null;
      }
      this.formError = null;
    }
  }

  patchDraft(patch: Partial<SecretsStoreDraft>) {
    if (patch.kind !== undefined) {
      this.secretKindOverridden = true;
    }
    if (patch.name !== undefined) {
      patch.name = patch.name.toUpperCase();
      if (!this.secretKindOverridden) {
        patch.kind = isSensitiveEnvName(patch.name) ? "secret" : "env";
      }
    }
    this.draft = { ...this.draft, ...patch };
    this.formError = null;
  }

  validateValue(value: string, kind: SecretsStoreDraft["kind"]): string | null {
    if (kind === "secret" && value.length === 0) {
      return t("secretsStore.required");
    }
    if (new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) {
      return t("secretsStore.tooLarge");
    }
    return null;
  }

  saveEntryTask<Result extends { warningCount?: number }>(
    save: (store: SecretsStoreState) => Promise<Result | null>,
    finish: (result: Result) => string,
  ) {
    return this.runStoreTask(async (store) => {
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

  submitDraft() {
    if (!this.canCall("secrets.store.set") || !this.dialogMode) {
      return undefined;
    }
    const error = ENV_SECRET_REF_ID_RE.test(this.draft.name)
      ? this.validateValue(this.draft.value, this.draft.kind)
      : t("secretsStore.badName");
    if (error) {
      this.formError = error;
      return undefined;
    }
    const draft = { ...this.draft };
    return this.saveEntryTask(
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

  openBulk() {
    if (!this.canCall("secrets.store.set")) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.bulkRaw = "";
    this.bulkAutoDetect = true;
    this.bulkOpen = true;
  }

  get bulkParsed() {
    return parseSecretsStoreBulkInput(this.bulkRaw, this.bulkAutoDetect);
  }

  submitBulk() {
    if (!this.canCall("secrets.store.set") || !this.bulkOpen) {
      return undefined;
    }
    const parsed = this.bulkParsed;
    if (parsed.invalidNames.length > 0) {
      this.formError = `${t("secretsStore.badName")} ${parsed.invalidNames.join(", ")}`;
      return undefined;
    }
    if (parsed.entries.length === 0) {
      this.formError = t("secretsStore.required");
      return undefined;
    }
    for (const entry of parsed.entries) {
      const error = this.validateValue(entry.value, entry.kind);
      if (error) {
        this.formError = `${entry.name}: ${error}`;
        return undefined;
      }
    }
    return this.saveEntryTask(
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

  async removeEntry(entry: (typeof this.store.entries)[number]) {
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
      this.notify();
      return;
    }
    await this.runStoreTask(async (store) => {
      const result = await deleteSecretsStoreEntry(store, entry.name);
      if (result && this.store === store) {
        this.notice = t("secretsStore.deleted", { name: entry.name });
      }
    });
  }
}
