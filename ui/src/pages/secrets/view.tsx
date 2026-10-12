import { For, Show } from "solid-js";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/modal-dialog.ts";
import {
  DocsLink,
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsPage,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import "../../components/web-awesome.ts";
import { formatRelativeTimestamp } from "../../lib/reactive/format.ts";
import { getLocale, t } from "../../lib/reactive/i18n.ts";
import type { SecretsStoreDraft } from "../../lib/secrets-store/index.ts";
import type { JSX as SolidJSX } from "../../types/solid-elements.d.ts";
import "../../styles/secrets-store.css";

export type SecretsDialogMode = "add" | "edit" | null;

type SecretsStoreViewProps = {
  entries: SecretStoreEntry[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  canList: boolean;
  canSet: boolean;
  canDelete: boolean;
  dialogMode: SecretsDialogMode;
  draft: SecretsStoreDraft;
  formError: string | null;
  bulkOpen: boolean;
  bulkRaw: string;
  bulkAutoDetect: boolean;
  bulkSecretCount: number;
  bulkEntryCount: number;
  bulkInvalidNames: readonly string[];
  onRefresh: () => void;
  onOpenAdd: () => void;
  onOpenEdit: (entry: SecretStoreEntry) => void;
  onCloseDialog: () => void;
  onDraftChange: (patch: Partial<SecretsStoreDraft>) => void;
  onSubmitDraft: () => void;
  onOpenBulk: () => void;
  onCloseBulk: () => void;
  onBulkRawChange: (raw: string) => void;
  onBulkAutoDetectChange: (enabled: boolean) => void;
  onSubmitBulk: () => void;
  onDelete: (entry: SecretStoreEntry) => void;
};

const DOCS_URL = "https://docs.openclaw.ai/gateway/secrets#shared-secret-store";
const SECRET_MASK = "••••••••";

function TextAreaField(props: { view: SecretsStoreViewProps; field: "value" | "hosts" | "bulk" }) {
  const name = () =>
    props.field === "hosts" ? "allowed-hosts" : props.field === "bulk" ? "bulk-values" : "value";
  const value = () =>
    props.field === "hosts"
      ? props.view.draft.allowedHosts
      : props.field === "bulk"
        ? props.view.bulkRaw
        : props.view.draft.value;
  const input = (next: string) => {
    if (props.field === "hosts") {
      props.view.onDraftChange({ allowedHosts: next });
    } else if (props.field === "bulk") {
      props.view.onBulkRawChange(next);
    } else {
      props.view.onDraftChange({ value: next });
    }
  };
  return (
    <label class="secrets-store-field">
      <span>{t(props.field === "hosts" ? "secretsStore.allowedHosts" : "secretsStore.value")}</span>
      <textarea
        class={[
          "settings-input",
          `secrets-store-dialog__${props.field}`,
          { mono: props.field === "hosts" },
        ]}
        name={name()}
        autocomplete="off"
        spellcheck="false"
        autofocus={props.field === "bulk"}
        placeholder={
          props.field === "hosts" ? t("secretsStore.allowedHostsPlaceholder") : undefined
        }
        disabled={props.view.busy}
        value={value()}
        onInput={(event) => input(event.currentTarget.value)}
      />
      <Show when={props.field === "hosts"}>
        <small>{t("secretsStore.allowedHostsHint")}</small>
      </Show>
    </label>
  );
}

function updatedLabel(entry: SecretStoreEntry): string {
  const relative = formatRelativeTimestamp(entry.updatedAtMs, { fallback: t("common.unknown") });
  return entry.updatedBy
    ? t("secretsStore.by", { time: relative, name: entry.updatedBy })
    : relative;
}

function EntryMenu(props: { view: SecretsStoreViewProps; entry: SecretStoreEntry }) {
  return (
    <Show when={props.view.canSet || props.view.canDelete}>
      <wa-dropdown
        class="secrets-store__menu"
        placement="bottom-end"
        onWa-select={(event: CustomEvent<{ item: { value?: string } }>) => {
          if (event.detail.item.value === "edit" && props.view.canSet) {
            props.view.onOpenEdit(props.entry);
          } else if (event.detail.item.value === "delete" && props.view.canDelete) {
            props.view.onDelete(props.entry);
          }
        }}
      >
        <button
          slot="trigger"
          type="button"
          class="btn btn--sm btn--ghost secrets-store__menu-trigger"
          aria-label={`${t("secretsStore.actions")}: ${props.entry.name}`}
          title={t("secretsStore.actions")}
          disabled={props.view.busy}
        >
          <Icon name="moreHorizontal" />
        </button>
        <Show when={props.view.canSet}>
          <wa-dropdown-item value="edit">{t("secretsStore.edit")}</wa-dropdown-item>
        </Show>
        <Show when={props.view.canDelete}>
          <wa-dropdown-item value="delete" prop:variant="danger">
            {t("common.delete")}
          </wa-dropdown-item>
        </Show>
      </wa-dropdown>
    </Show>
  );
}

function SecretsTable(props: SecretsStoreViewProps) {
  return (
    <Show when={props.canList} fallback={<SettingsEmpty message={t("secretsStore.unavail")} />}>
      <Show
        when={!props.loading || props.entries.length > 0}
        fallback={<SettingsLoadingSkeleton />}
      >
        <Show
          when={props.entries.length > 0}
          fallback={
            <div class="secrets-store__empty">
              <SettingsEmpty message={t("tabs.secrets")} />
              <DocsLink url={DOCS_URL}>{t("common.docs")}</DocsLink>
            </div>
          }
        >
          <div class="secrets-store__table-wrap">
            <table class="secrets-store__table settings-table--stacked" role="table">
              <thead>
                <tr>
                  <th scope="col">{t("secretsStore.name")}</th>
                  <th scope="col">{t("secretsStore.access")}</th>
                  <th scope="col">{t("secretsStore.value")}</th>
                  <th scope="col">{t("secretsStore.allowedHosts")}</th>
                  <th scope="col">{t("secretsStore.updated")}</th>
                  <th scope="col" class="secrets-store__actions-heading">
                    <span class="settings-control__sr-label">{t("secretsStore.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={props.entries} keyed={(entry) => entry.name}>
                  {(entry) => {
                    const value = () => {
                      const item = entry();
                      return item.kind === "env" ? item.value : undefined;
                    };
                    const hosts = () => {
                      const item = entry();
                      return item.kind === "secret" && item.allowedHosts?.length
                        ? item.allowedHosts.join(", ")
                        : t("secretsStore.noAllowedHosts");
                    };
                    return (
                      <tr tabindex="0" aria-label={entry().name}>
                        <td data-label={t("secretsStore.name")}>
                          <code class="secrets-store__name" title={entry().name}>
                            {entry().name}
                          </code>
                        </td>
                        <td data-label={t("secretsStore.access")}>
                          <span class={`secrets-store__mode secrets-store__mode--${entry().kind}`}>
                            {t(
                              entry().kind === "secret"
                                ? "secretsStore.protectedSecret"
                                : "secretsStore.agentReadable",
                            )}
                          </span>
                        </td>
                        <td data-label={t("secretsStore.value")}>
                          <span
                            class={[
                              "secrets-store__value",
                              { "secrets-store__value--secret": entry().kind === "secret" },
                            ]}
                            title={value()}
                          >
                            {value() ?? SECRET_MASK}
                          </span>
                        </td>
                        <td data-label={t("secretsStore.allowedHosts")}>
                          <span class="secrets-store__hosts">{hosts()}</span>
                        </td>
                        <td data-label={t("secretsStore.updated")}>
                          <time
                            class="secrets-store__updated"
                            datetime={new Date(entry().updatedAtMs).toISOString()}
                            title={new Intl.DateTimeFormat(getLocale(), {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(entry().updatedAtMs))}
                          >
                            {updatedLabel(entry())}
                          </time>
                        </td>
                        <td
                          class="secrets-store__actions-cell"
                          data-label={t("secretsStore.actions")}
                        >
                          <EntryMenu view={props} entry={entry()} />
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
    </Show>
  );
}

function SecretDialog(props: {
  view: SecretsStoreViewProps;
  bulk?: boolean;
  children: SolidJSX.Element;
}) {
  const title = () =>
    t(
      props.bulk
        ? "secretsStore.bulk"
        : props.view.dialogMode === "edit"
          ? "secretsStore.edit"
          : "secretsStore.add",
    );
  const close = () => (props.bulk ? props.view.onCloseBulk() : props.view.onCloseDialog());
  return (
    <openclaw-modal-dialog
      label={title()}
      description={props.bulk ? undefined : t("secretsStore.hint")}
      onModal-cancel={close}
    >
      <form
        class="secrets-store-dialog"
        aria-busy={props.view.busy ? "true" : "false"}
        onSubmit={(event) => {
          event.preventDefault();
          if (props.bulk) {
            props.view.onSubmitBulk();
          } else {
            props.view.onSubmitDraft();
          }
        }}
      >
        <div class="secrets-store-dialog__header">
          <h2>{title()}</h2>
        </div>
        {props.children}
        <Show when={props.view.formError}>
          <div class="callout danger" role="alert">
            {props.view.formError}
          </div>
        </Show>
        <div class="secrets-store-dialog__actions">
          <button
            class="btn primary"
            type="submit"
            disabled={
              props.view.busy ||
              Boolean(
                props.bulk &&
                (!props.view.bulkEntryCount || props.view.bulkInvalidNames.length > 0),
              )
            }
          >
            {props.view.busy ? t("common.saving") : t("common.save")}
          </button>
          <button class="btn" type="button" disabled={props.view.busy} onClick={close}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </openclaw-modal-dialog>
  );
}

function EntryDialog(props: SecretsStoreViewProps) {
  return (
    <Show when={props.dialogMode}>
      <SecretDialog view={props}>
        <label class="secrets-store-field">
          <span>{t("secretsStore.name")}</span>
          <input
            class="settings-input mono"
            name="name"
            autocomplete="off"
            spellcheck="false"
            autofocus
            readonly={props.dialogMode === "edit"}
            disabled={props.busy}
            value={props.draft.name}
            onInput={(event) => props.onDraftChange({ name: event.currentTarget.value })}
          />
        </label>
        <TextAreaField view={props} field="value" />
        <fieldset class="secrets-store-modes">
          <legend>{t("secretsStore.accessMode")}</legend>
          <For each={["secret", "env"] as const} keyed={false}>
            {(kind) => (
              <label
                class={[
                  "secrets-store-mode",
                  {
                    "secrets-store-mode--selected": props.draft.kind === kind(),
                    "secrets-store-mode--risk": props.draft.kind === kind() && kind() === "env",
                  },
                ]}
              >
                <input
                  type="radio"
                  name="access-mode"
                  value={kind()}
                  checked={props.draft.kind === kind()}
                  disabled={props.busy}
                  onChange={() => props.onDraftChange({ kind: kind() })}
                />
                <span>
                  <strong>
                    {t(
                      kind() === "secret"
                        ? "secretsStore.protectedSecret"
                        : "secretsStore.agentReadable",
                    )}
                  </strong>
                  <small>
                    {t(
                      kind() === "secret"
                        ? "secretsStore.protectedSecretHint"
                        : "secretsStore.agentReadableHint",
                    )}
                  </small>
                </span>
              </label>
            )}
          </For>
        </fieldset>
        <Show when={props.draft.kind === "secret"}>
          <TextAreaField view={props} field="hosts" />
        </Show>
      </SecretDialog>
    </Show>
  );
}

function BulkDialog(props: SecretsStoreViewProps) {
  return (
    <Show when={props.bulkOpen}>
      <SecretDialog view={props} bulk>
        <TextAreaField view={props} field="bulk" />
        <div class="secrets-store-bulk__summary" aria-live="polite">
          {t(props.bulkSecretCount === 1 ? "secretsStore.detectedOne" : "secretsStore.detected", {
            count: String(props.bulkSecretCount),
          })}
        </div>
        <label class="secrets-store-checkbox">
          <input
            type="checkbox"
            checked={props.bulkAutoDetect}
            disabled={props.busy}
            onChange={(event) => props.onBulkAutoDetectChange(event.currentTarget.checked)}
          />
          <span>
            <strong>{t("secretsStore.detect")}</strong>
          </span>
        </label>
        <Show when={props.bulkInvalidNames.length > 0}>
          <div class="callout danger" role="alert">
            {t("secretsStore.badName")} {props.bulkInvalidNames.join(", ")}
          </div>
        </Show>
      </SecretDialog>
    </Show>
  );
}

export function SecretsStore(props: SecretsStoreViewProps) {
  return (
    <>
      <SettingsPage wide>
        <Show when={props.error}>
          <div class="callout danger secrets-store__message" role="alert">
            <span>{props.error}</span>
            <Show when={props.canList}>
              <button class="btn btn--sm" type="button" onClick={() => props.onRefresh()}>
                {t("common.retry")}
              </button>
            </Show>
          </div>
        </Show>
        <Show when={props.notice}>
          <div class="callout success secrets-store__message" role="status" aria-live="polite">
            {props.notice}
          </div>
        </Show>
        <SettingsSection
          title={t("tabs.secrets")}
          count={props.entries.length}
          actions={
            <Show when={props.canSet}>
              <>
                <button
                  class="btn btn--sm"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onOpenBulk()}
                >
                  {t("secretsStore.bulk")}
                </button>
                <button
                  class="btn btn--sm primary"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onOpenAdd()}
                >
                  <Icon name="plus" /> {t("secretsStore.add")}
                </button>
              </>
            </Show>
          }
        >
          <SecretsTable {...props} />
        </SettingsSection>
      </SettingsPage>
      <EntryDialog {...props} />
      <BulkDialog {...props} />
    </>
  );
}
