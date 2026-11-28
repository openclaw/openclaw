import { createSignal, For, Show } from "solid-js";
import {
  WRITING_PROFILE_LIMITS,
  type WritingApplicationIdentity,
  type WritingProfile,
  type WritingProfilePolicy,
  type WritingProfileSelector,
} from "../../../../src/shared/dictation-writing-profiles.js";
import { registerDictationWritingProfilesEnglish } from "../../i18n/locales/en-dictation-writing-profiles.ts";
import { t } from "../../lib/reactive/i18n.ts";

registerDictationWritingProfilesEnglish();
const copy = "talkPage.writingProfiles.";
type ChoicePolicyKey = Exclude<keyof WritingProfilePolicy, "locale">;

function PriorityField(props: { value: number; onChange: (value: number) => void }) {
  // Keep incomplete native number input (for example a leading minus) while typing.
  const [draft, setDraft] = createSignal(() => String(props.value));
  return (
    <label class="field">
      <span>{t(copy + "priority")}</span>
      <input
        class="settings-input"
        type="number"
        step="1"
        required
        min={-WRITING_PROFILE_LIMITS.priority}
        max={WRITING_PROFILE_LIMITS.priority}
        value={draft()}
        onInput={(event) => {
          setDraft(event.currentTarget.value);
          if (Number.isFinite(event.currentTarget.valueAsNumber)) {
            props.onChange(event.currentTarget.valueAsNumber);
          }
        }}
      />
      <small>{t(copy + "priorityHelp")}</small>
    </label>
  );
}

function PolicySelect<K extends ChoicePolicyKey>(props: {
  field: K;
  policy: WritingProfilePolicy;
  options: readonly WritingProfilePolicy[K][];
  onChange: (policy: WritingProfilePolicy) => void;
}) {
  return (
    <label class="field">
      <span>{t(copy + props.field)}</span>
      <select
        class="settings-select"
        value={props.policy[props.field]}
        onChange={(event) => {
          const next = props.options.find((option) => option === event.currentTarget.value);
          if (next) {
            props.onChange({ ...props.policy, [props.field]: next });
          }
        }}
      >
        <For each={props.options}>
          {(option) => <option value={option}>{t(copy + option)}</option>}
        </For>
      </select>
    </label>
  );
}

const APP_KINDS: readonly WritingApplicationIdentity["kind"][] = [
  "macos-bundle-id",
  "windows-aumid",
  "linux-desktop-id",
];
const APP_LABELS: Record<WritingApplicationIdentity["kind"], string> = {
  "macos-bundle-id": "macos",
  "windows-aumid": "windows",
  "linux-desktop-id": "linux",
};

function SelectorFields(props: {
  selector: WritingProfileSelector;
  index: number;
  onChange: (selector: WritingProfileSelector) => void;
  onRemove: () => void;
}) {
  return (
    <fieldset class="writing-profiles__selector stack settings-group">
      <legend>{t(copy + "selectorNumber", { number: String(props.index + 1) })}</legend>
      <div class="writing-profiles__grid grid">
        <label class="field">
          <span>{t(copy + "selectorKind")}</span>
          <select
            class="settings-select"
            value={props.selector.kind}
            onChange={(event) => {
              props.onChange(
                event.currentTarget.value === "origin"
                  ? { kind: "origin", app: props.selector.app, origin: "" }
                  : { kind: "application", app: props.selector.app },
              );
            }}
          >
            <option value="application">{t(copy + "application")}</option>
            <option value="origin">{t(copy + "applicationOrigin")}</option>
          </select>
        </label>
        <label class="field">
          <span>{t(copy + "platform")}</span>
          <select
            class="settings-select"
            value={props.selector.app.kind}
            onChange={(event) => {
              const kind = APP_KINDS.find((value) => value === event.currentTarget.value);
              if (kind) {
                props.onChange({ ...props.selector, app: { ...props.selector.app, kind } });
              }
            }}
          >
            <For each={APP_KINDS}>
              {(kind) => <option value={kind}>{t(copy + APP_LABELS[kind])}</option>}
            </For>
          </select>
        </label>
        <label class="field">
          <span>{t(copy + "applicationId")}</span>
          <input
            class="settings-input"
            type="text"
            required
            maxlength={WRITING_PROFILE_LIMITS.identifier}
            value={props.selector.app.id}
            spellcheck="false"
            autocomplete="off"
            onInput={(event) =>
              props.onChange({
                ...props.selector,
                app: { ...props.selector.app, id: event.currentTarget.value },
              })
            }
          />
        </label>
        <Show when={props.selector.kind === "origin" && props.selector}>
          {(selector) => (
            <label class="field">
              <span>{t(copy + "origin")}</span>
              <input
                class="settings-input"
                type="url"
                required
                maxlength={WRITING_PROFILE_LIMITS.origin}
                value={selector().origin}
                spellcheck="false"
                autocomplete="off"
                onInput={(event) =>
                  props.onChange({ ...selector(), origin: event.currentTarget.value })
                }
              />
              <small>{t(copy + "originHelp")}</small>
            </label>
          )}
        </Show>
      </div>
      <button class="btn btn--sm" type="button" onClick={() => props.onRemove()}>
        {t(copy + "removeSelector", { number: String(props.index + 1) })}
      </button>
    </fieldset>
  );
}

export function WritingProfileFields(props: {
  profile: WritingProfile;
  onChange: (patch: Partial<Omit<WritingProfile, "id" | "revision">>) => void;
}) {
  const changePolicy = (policy: WritingProfilePolicy) => props.onChange({ policy });
  return (
    <div class="stack">
      <div class="writing-profiles__grid grid">
        <label class="field">
          <span>{t(copy + "label")}</span>
          <input
            class="settings-input"
            type="text"
            required
            maxlength={WRITING_PROFILE_LIMITS.label}
            value={props.profile.label}
            onInput={(event) => props.onChange({ label: event.currentTarget.value })}
          />
        </label>
        <PriorityField
          value={props.profile.priority}
          onChange={(priority) => props.onChange({ priority })}
        />
      </div>
      <label class="field checkbox">
        <input
          type="checkbox"
          checked={props.profile.enabled}
          onChange={(event) => props.onChange({ enabled: event.currentTarget.checked })}
        />
        <span>{t(copy + "profileEnabled")}</span>
      </label>
      <div class="writing-profiles__grid grid">
        <PolicySelect
          field="handling"
          policy={props.profile.policy}
          options={["literal", "prose"]}
          onChange={changePolicy}
        />
        <PolicySelect
          field="punctuation"
          policy={props.profile.policy}
          options={["preserve", "automatic"]}
          onChange={changePolicy}
        />
        <PolicySelect
          field="capitalization"
          policy={props.profile.policy}
          options={["preserve", "sentence"]}
          onChange={changePolicy}
        />
        <PolicySelect
          field="fillers"
          policy={props.profile.policy}
          options={["preserve", "conservative"]}
          onChange={changePolicy}
        />
        <PolicySelect
          field="corrections"
          policy={props.profile.policy}
          options={["preserve", "explicit"]}
          onChange={changePolicy}
        />
        <PolicySelect
          field="structure"
          policy={props.profile.policy}
          options={["preserve", "paragraphs", "lists"]}
          onChange={changePolicy}
        />
        <PolicySelect
          field="register"
          policy={props.profile.policy}
          options={["unchanged", "chat", "email"]}
          onChange={changePolicy}
        />
        <label class="field">
          <span>{t(copy + "locale")}</span>
          <input
            class="settings-input"
            type="text"
            maxlength={64}
            value={props.profile.policy.locale ?? ""}
            spellcheck="false"
            onInput={(event) =>
              changePolicy({ ...props.profile.policy, locale: event.currentTarget.value || null })
            }
          />
          <small>{t(copy + "localeHelp")}</small>
        </label>
      </div>
      <details class="writing-profiles__disclosure">
        <summary>{t(copy + "selectors")}</summary>
        <p>{t(copy + "selectorsHelp")}</p>
        <For each={props.profile.selectors} keyed={false}>
          {(selector, index) => (
            <SelectorFields
              selector={selector()}
              index={index}
              onChange={(next) =>
                props.onChange({
                  selectors: props.profile.selectors.map((item, position) =>
                    position === index ? next : item,
                  ),
                })
              }
              onRemove={() =>
                props.onChange({
                  selectors: props.profile.selectors.filter(
                    (_item, position) => position !== index,
                  ),
                })
              }
            />
          )}
        </For>
        <button
          class="btn btn--sm"
          type="button"
          disabled={props.profile.selectors.length >= WRITING_PROFILE_LIMITS.selectors}
          onClick={() =>
            props.onChange({
              selectors: [
                ...props.profile.selectors,
                { kind: "application", app: { kind: "macos-bundle-id", id: "" } },
              ],
            })
          }
        >
          {t(copy + "addSelector")}
        </button>
      </details>
    </div>
  );
}
