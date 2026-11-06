import { createMemo, For, Loading, Show } from "solid-js";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu } from "../../components/solid/menu.tsx";
import { Radio } from "../../components/solid/radio.tsx";
import "../../components/modal-dialog.tsx";
import {
  DocsLink,
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsPage,
  SettingsSection,
  SettingsStatus,
  SettingsUnavailable,
} from "../../components/solid/settings-ui.tsx";
import { formatRelativeTimestamp } from "../../lib/reactive/format.ts";
import { getLocale, t } from "../../lib/reactive/i18n.ts";
import type { SecretsStoreState } from "../../lib/secrets-store/index.ts";
import type { JSX as SolidJSX } from "../../types/solid-elements.d.ts";
import "../../styles/secrets-store.css";
import type { SecretsPageState } from "./state.ts";

type SecretsStoreViewProps = {
  state: SecretsPageState;
  scope: SecretsStoreState;
  read: () => readonly SecretStoreEntry[];
  busy: boolean;
  onSubmit: (bulk: boolean) => void;
  onRemove: (entry: SecretStoreEntry) => void;
  bulkSecretCount: number;
  bulkEntryCount: number;
  bulkInvalidNames: readonly string[];
};

const DOCS_URL = "https://docs.openclaw.ai/gateway/secrets#shared-secret-store";

function TextAreaField(props: {
  view: SecretsStoreViewProps;
  field: "value" | "hosts" | "bulk";
  onInputRef?: (element: HTMLTextAreaElement) => void;
}) {
  const name = () =>
    props.field === "hosts" ? "allowed-hosts" : props.field === "bulk" ? "bulk-values" : "value";
  const value = () =>
    props.field === "hosts"
      ? props.view.state.draft.allowedHosts
      : props.field === "bulk"
        ? props.view.state.bulkRaw
        : props.view.state.draft.value;
  const input = (next: string) => {
    if (props.field === "hosts") {
      props.view.state.act((state) => state.patchDraft({ allowedHosts: next }));
    } else if (props.field === "bulk") {
      props.view.state.act((state) => {
        state.bulkRaw = next;
        state.formError = null;
      });
    } else {
      props.view.state.act((state) => state.patchDraft({ value: next }));
    }
  };
  return (
    <label class="secrets-store-field">
      <span>{t(props.field === "hosts" ? "secretsStore.allowedHosts" : "secretsStore.value")}</span>
      <textarea
        ref={props.onInputRef}
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
    <Show
      when={
        props.view.state.canCall("secrets.store.set") ||
        props.view.state.canCall("secrets.store.delete")
      }
    >
      <Menu
        id={`secret-actions-${props.entry.name}`}
        lazy
        class="secrets-store__menu"
        placement="bottom-end"
        label={`${t("secretsStore.actions")}: ${props.entry.name}`}
        triggerClass="btn btn--sm btn--ghost secrets-store__menu-trigger"
        triggerAttributes={{ title: t("secretsStore.actions") }}
        trigger={<Icon name="moreHorizontal" />}
        disabled={props.view.busy}
        items={[
          ...(props.view.state.canCall("secrets.store.set")
            ? [{ id: "edit", label: t("secretsStore.edit") }]
            : []),
          ...(props.view.state.canCall("secrets.store.delete")
            ? [{ id: "delete", label: t("common.delete"), variant: "danger" as const }]
            : []),
        ]}
        onSelect={(item) => {
          if (item.id === "edit" && props.view.state.canCall("secrets.store.set")) {
            const entry = props.entry;
            props.view.state.act((state) => state.openEntry(entry));
          } else if (item.id === "delete" && props.view.state.canCall("secrets.store.delete")) {
            props.view.onRemove(props.entry);
          }
        }}
      />
    </Show>
  );
}

function SecretsTable(props: SecretsStoreViewProps) {
  const timestamp = createMemo(
    () => {
      // Refresh the system timezone with the inventory.
      props.read();
      return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" });
    },
    { lazy: true },
  );
  return (
    <Show
      when={props.state.canCall("secrets.store.list")}
      fallback={<SettingsUnavailable message={props.state.unavailableMessage()} />}
    >
      <Loading on={props.scope} fallback={<SettingsLoadingSkeleton />}>
        <Show
          when={props.read().length > 0}
          fallback={
            <SettingsEmpty
              message={
                <>
                  {t("secretsStore.empty")} <DocsLink url={DOCS_URL}>{t("common.docs")}</DocsLink>
                </>
              }
            />
          }
        >
          <div class="secrets-store__list" role="list">
            <For each={props.read()} keyed={(entry) => entry.name}>
              {(entry) => {
                const secret = () => entry().kind === "secret";
                const detail = () => {
                  const item = entry();
                  return item.kind === "env" ? item.value : item.allowedHosts?.join(", ");
                };
                return (
                  <div
                    class="settings-row secrets-store__row"
                    role="listitem"
                    aria-label={entry().name}
                  >
                    <div class="settings-row__text">
                      <code class="settings-row__title secrets-store__name" title={entry().name}>
                        {entry().name}
                      </code>
                      <span
                        class={[
                          "settings-row__desc",
                          "secrets-store__meta",
                          { "secrets-store__meta--flow": secret() },
                        ]}
                      >
                        <Show when={detail()}>
                          {(text) => (
                            <>
                              <span
                                class={[
                                  "secrets-store__value",
                                  { "secrets-store__value--hosts": secret() },
                                ]}
                                title={text()}
                              >
                                {text()}
                              </span>
                              <span class="secrets-store__separator" aria-hidden="true">
                                ·
                              </span>
                            </>
                          )}
                        </Show>
                        <time
                          class="secrets-store__updated"
                          datetime={new Date(entry().updatedAtMs).toISOString()}
                          title={timestamp().format(entry().updatedAtMs)}
                        >
                          {updatedLabel(entry())}
                        </time>
                      </span>
                    </div>
                    <div class="settings-row__control">
                      <SettingsStatus
                        kind={secret() ? "muted" : "warn"}
                        label={t(
                          secret() ? "secretsStore.protectedSecret" : "secretsStore.agentReadable",
                        )}
                      />
                      <EntryMenu view={props} entry={entry()} />
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Loading>
    </Show>
  );
}

function SecretDialog(props: {
  view: SecretsStoreViewProps;
  bulk?: boolean;
  initialFocus: () => HTMLElement;
  children: SolidJSX.Element;
}) {
  const title = () =>
    t(
      props.bulk
        ? "secretsStore.bulk"
        : props.view.state.dialogMode === "edit"
          ? "secretsStore.editDialogTitle"
          : "secretsStore.addDialogTitle",
    );
  const close = () => {
    const bulk = props.bulk;
    props.view.state.act((state) => state.closeDialog(bulk));
  };
  return (
    <openclaw-modal-dialog
      prop:initialFocus={props.initialFocus}
      label={title()}
      description={props.bulk ? undefined : t("secretsStore.hint")}
      onModal-cancel={close}
    >
      <form
        class="oc-dialog secrets-store-dialog"
        aria-busy={props.view.busy ? "true" : "false"}
        onSubmit={(event) => {
          event.preventDefault();
          props.view.onSubmit(Boolean(props.bulk));
        }}
      >
        <DialogHeader title={title()} closeDisabled={props.view.busy} onClose={close} />
        <div class="oc-dialog__body">
          {props.children}
          <Show when={props.view.state.formError}>
            <div class="callout danger" role="alert">
              {props.view.state.formError}
            </div>
          </Show>
        </div>
        <openclaw-modal-actions class="oc-dialog__footer">
          <button class="btn" type="button" disabled={props.view.busy} onClick={close}>
            {t("common.cancel")}
          </button>
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
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}

function EntryDialog(props: SecretsStoreViewProps) {
  let nameInput!: HTMLInputElement;
  return (
    <Show when={props.state.dialogMode}>
      <SecretDialog view={props} initialFocus={() => nameInput}>
        <label class="secrets-store-field">
          <span>{t("secretsStore.name")}</span>
          <input
            ref={(element) => {
              nameInput = element;
            }}
            class="settings-input mono"
            name="name"
            autocomplete="off"
            spellcheck="false"
            autofocus
            readonly={props.state.dialogMode === "edit"}
            disabled={props.busy}
            value={props.state.draft.name}
            onInput={(event) =>
              props.state.act((state) => state.patchDraft({ name: event.currentTarget.value }))
            }
          />
        </label>
        <TextAreaField view={props} field="value" />
        <fieldset class="secrets-store-modes">
          <legend>{t("secretsStore.accessMode")}</legend>
          <For each={["secret", "env"] as const} keyed={false}>
            {(kind) => (
              <Radio
                class={[
                  "secrets-store-mode",
                  {
                    "secrets-store-mode--selected": props.state.draft.kind === kind(),
                    "secrets-store-mode--risk":
                      props.state.draft.kind === kind() && kind() === "env",
                  },
                ]}
                name="access-mode"
                value={kind()}
                checked={props.state.draft.kind === kind()}
                disabled={props.busy}
                onChange={() => {
                  const selectedKind = kind();
                  props.state.act((state) => state.patchDraft({ kind: selectedKind }));
                }}
              >
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
              </Radio>
            )}
          </For>
        </fieldset>
        <Show when={props.state.draft.kind === "secret"}>
          <TextAreaField view={props} field="hosts" />
        </Show>
      </SecretDialog>
    </Show>
  );
}

function BulkDialog(props: SecretsStoreViewProps) {
  let bulkInput!: HTMLTextAreaElement;
  return (
    <Show when={props.state.bulkOpen}>
      <SecretDialog view={props} bulk initialFocus={() => bulkInput}>
        <TextAreaField
          view={props}
          field="bulk"
          onInputRef={(element) => {
            bulkInput = element;
          }}
        />
        <div class="secrets-store-bulk__summary" aria-live="polite">
          {t(props.bulkSecretCount === 1 ? "secretsStore.detectedOne" : "secretsStore.detected", {
            count: String(props.bulkSecretCount),
          })}
        </div>
        <label class="secrets-store-checkbox">
          <input
            type="checkbox"
            checked={props.state.bulkAutoDetect}
            disabled={props.busy}
            onChange={(event) =>
              props.state.act((state) => {
                state.bulkAutoDetect = event.currentTarget.checked;
                state.formError = null;
              })
            }
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
        <Show when={props.state.store.error}>
          <div class="callout danger secrets-store__message" role="alert">
            <span>{props.state.store.error}</span>
            <Show when={props.state.canCall("secrets.store.list")}>
              <button
                class="btn btn--sm"
                type="button"
                onClick={() => {
                  if (props.state.canCall("secrets.store.list")) {
                    props.state.reload();
                  }
                }}
              >
                {t("common.retry")}
              </button>
            </Show>
          </div>
        </Show>
        <Show when={props.state.notice}>
          <div class="callout success secrets-store__message" role="status" aria-live="polite">
            {props.state.notice}
          </div>
        </Show>
        <SettingsSection
          actions={
            <Show when={props.state.canCall("secrets.store.set")}>
              <>
                <button
                  class="btn btn--sm"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.state.act((state) => state.openBulk())}
                >
                  {t("secretsStore.bulk")}
                </button>
                <button
                  class="btn btn--sm primary"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.state.act((state) => state.openEntry())}
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
