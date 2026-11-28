import { t } from "../../lib/reactive/i18n.ts";

export function ProfileNameEditor(props: {
  name: string;
  saving: boolean;
  onInput: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <form
      class="model-providers__profile-copy model-providers__inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!props.saving) {
          props.onSave();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !props.saving) {
          event.preventDefault();
          event.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <div class="field">
        <input
          ref={(element) =>
            queueMicrotask(() => {
              element.focus();
              element.select();
            })
          }
          aria-label={t("modelProviders.profiles.accountName")}
          placeholder={t("modelProviders.profiles.accountNamePlaceholder")}
          value={props.name}
          maxlength={80}
          readonly={props.saving}
          onInput={(event) => props.onInput(event.currentTarget.value)}
        />
      </div>
      <button class="btn btn--sm" type="submit" disabled={props.saving}>
        {t("common.save")}
      </button>
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        disabled={props.saving}
        onClick={() => props.onCancel()}
      >
        {t("common.cancel")}
      </button>
    </form>
  );
}
