import { html, nothing, type TemplateResult } from "lit";
import type { NostrProfile as NostrProfileType } from "../../api/types.ts";
import { renderSettingsRow, renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";

export interface NostrProfileFormState {
  values: NostrProfileType;
  original: NostrProfileType;
  saving: boolean;
  importing: boolean;
  error: string | null;
  success: string | null;
  fieldErrors: Record<string, string>;
  showAdvanced: boolean;
}

export interface NostrProfileFormCallbacks {
  onFieldChange: (field: keyof NostrProfileType, value: string) => void;
  onSave: () => void;
  onImport: () => void;
  onCancel: () => void;
  onToggleAdvanced: () => void;
}

type ProfileField = readonly [
  key: keyof NostrProfileType,
  label: string,
  placeholder: string,
  help: string,
  type: "text" | "url" | "textarea",
];

const BASIC_FIELDS = [
  ["name", "username", "placeholders.username", "usernameHelp", "text"],
  ["displayName", "displayName", "placeholders.displayName", "displayNameHelp", "text"],
  ["about", "bio", "bioPlaceholder", "bioHelp", "textarea"],
  ["picture", "avatarUrl", "placeholders.avatarUrl", "avatarHelp", "url"],
] as const satisfies readonly ProfileField[];

const ADVANCED_FIELDS = [
  ["banner", "bannerUrl", "placeholders.bannerUrl", "bannerHelp", "url"],
  ["website", "website", "placeholders.website", "websiteHelp", "url"],
  ["nip05", "nip05Identifier", "placeholders.nip05", "nip05Help", "text"],
  ["lud16", "lightningAddress", "placeholders.lightningAddress", "lightningHelp", "text"],
] as const satisfies readonly ProfileField[];

export function renderNostrProfileForm(params: {
  state: NostrProfileFormState;
  callbacks: NostrProfileFormCallbacks;
  accountId: string;
}): TemplateResult {
  const { state, callbacks, accountId } = params;
  const isDirty = [...BASIC_FIELDS, ...ADVANCED_FIELDS].some(
    ([field]) => state.values[field] !== state.original[field],
  );

  const renderField = ([field, labelKey, placeholderKey, helpKey, type]: ProfileField) => {
    const label = t(`channels.nostr.${labelKey}`);
    const placeholder = t(`channels.nostr.${placeholderKey}`);
    const help = t(`channels.nostr.${helpKey}`);
    const onInput = (event: InputEvent) =>
      callbacks.onFieldChange(
        field,
        (event.target as HTMLInputElement | HTMLTextAreaElement).value,
      );
    const value = state.values[field] ?? "";
    const error = state.fieldErrors[field];

    const inputId = `nostr-profile-${field}`;
    const helpId = `${inputId}-help`;
    const errorId = `${inputId}-error`;
    const descriptionIds = [help ? helpId : "", error ? errorId : ""].filter(Boolean).join(" ");
    const control =
      type === "textarea"
        ? html`
            <textarea
              id="${inputId}"
              class="settings-input"
              .value=${value}
              placeholder=${placeholder}
              maxlength="2000"
              rows="3"
              aria-describedby=${descriptionIds || nothing}
              aria-invalid=${error ? "true" : nothing}
              @input=${onInput}
              ?disabled=${state.saving}
            ></textarea>
          `
        : html`
            <input
              id="${inputId}"
              class="settings-input"
              type=${type}
              .value=${value}
              placeholder=${placeholder}
              maxlength="256"
              aria-describedby=${descriptionIds || nothing}
              aria-invalid=${error ? "true" : nothing}
              @input=${onInput}
              ?disabled=${state.saving}
            />
          `;

    return html`
      <div class="settings-row settings-row--stacked">
        <div class="settings-row__text">
          <label class="settings-row__title" for="${inputId}">${label}</label>
          ${help ? html`<span id=${helpId} class="settings-row__desc">${help}</span>` : nothing}
          ${
            error
              ? html`<span id=${errorId} class="settings-row__desc" style="color: var(--danger);"
                  >${error}</span
                >`
              : nothing
          }
        </div>
        <div class="settings-row__control">${control}</div>
      </div>
    `;
  };

  return html`
    ${renderSettingsRow({
      title: t("channels.nostr.editProfile"),
      description: html`${t("channels.nostr.account")}: ${accountId}`,
    })}
    ${
      state.error
        ? renderSettingsRow({
            role: "alert",
            title: renderSettingsStatus({ kind: "danger", label: t("channels.lastError") }),
            description: state.error,
          })
        : nothing
    }
    ${
      state.success
        ? html`
            <div class="settings-row" role="status">
              <div class="settings-row__text">
                <span class="settings-row__desc">${state.success}</span>
              </div>
            </div>
          `
        : nothing
    }
    ${
      state.values.picture
        ? renderSettingsRow({
            title: t("channels.nostr.profilePicturePreview"),
            control: html`<img
              src=${state.values.picture}
              alt=${t("channels.nostr.profilePicturePreview")}
              style="max-width: 80px; max-height: 80px; border-radius: 50%; object-fit: cover;"
              @error=${(e: Event) => {
                const img = e.target as HTMLImageElement;
                img.style.display = "none";
              }}
              @load=${(e: Event) => {
                const img = e.target as HTMLImageElement;
                img.style.display = "block";
              }}
            />`,
          })
        : nothing
    }
    ${BASIC_FIELDS.map(renderField)}
    ${
      state.showAdvanced
        ? html`
            ${renderSettingsRow({ title: t("channels.nostr.advanced") })}
            ${ADVANCED_FIELDS.map(renderField)}
          `
        : nothing
    }

    <div class="settings-row">
      <div class="settings-row__text">
        ${
          isDirty
            ? html`<span class="settings-row__desc">${t("common.unsavedChanges")}</span>`
            : nothing
        }
      </div>
      <div class="settings-row__control">
        <button
          class="btn primary"
          @click=${callbacks.onSave}
          ?disabled=${state.saving || !isDirty}
        >
          ${state.saving ? t("common.saving") : t("common.saveAndPublish")}
        </button>

        <button
          class="btn"
          @click=${callbacks.onImport}
          ?disabled=${state.importing || state.saving}
        >
          ${state.importing ? t("common.importing") : t("common.importFromRelays")}
        </button>

        <button
          class="btn"
          aria-expanded=${String(state.showAdvanced)}
          @click=${callbacks.onToggleAdvanced}
        >
          ${state.showAdvanced ? t("common.hideAdvanced") : t("common.showAdvanced")}
        </button>

        <button class="btn" @click=${callbacks.onCancel} ?disabled=${state.saving}>
          ${t("common.cancel")}
        </button>
      </div>
    </div>
  `;
}

export function createNostrProfileFormState(
  profile: NostrProfileType | undefined,
): NostrProfileFormState {
  const values: NostrProfileType = {
    name: profile?.name ?? "",
    displayName: profile?.displayName ?? "",
    about: profile?.about ?? "",
    picture: profile?.picture ?? "",
    banner: profile?.banner ?? "",
    website: profile?.website ?? "",
    nip05: profile?.nip05 ?? "",
    lud16: profile?.lud16 ?? "",
  };

  return {
    values,
    original: { ...values },
    saving: false,
    importing: false,
    error: null,
    success: null,
    fieldErrors: {},
    showAdvanced: Boolean(profile?.banner || profile?.website || profile?.nip05 || profile?.lud16),
  };
}
