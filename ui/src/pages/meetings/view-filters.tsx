import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { createMemo, onSettled, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { createPhoneSheetLayout, PhoneSheet } from "../../components/solid/phone-sheet.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import {
  TRANSCRIPT_ADVANCED_FILTER_KEYS,
  TRANSCRIPT_FILTER_KEYS,
  TRANSCRIPT_QUERY_LIMIT,
} from "./route-state.ts";
import type { TranscriptsViewProps } from "./view-types.ts";

function FilterField(
  props: TranscriptsViewProps & { name: string; label: string; type?: string; compact?: boolean },
) {
  let input!: HTMLInputElement;
  onSettled(() => (props.name === "query" ? props.onFocusTarget?.("search", input) : undefined));
  return (
    <label class={["field", { "transcripts-filters__search": props.compact }]}>
      {props.compact ? (
        <span class="transcripts-filters__search-icon" aria-hidden="true">
          <Icon name="search" />
        </span>
      ) : (
        <span>{props.label}</span>
      )}
      <input
        name={props.name}
        type={props.type ?? "search"}
        aria-label={props.label}
        placeholder={props.compact ? props.label : undefined}
        maxlength={TRANSCRIPT_QUERY_LIMIT}
        ref={[liveValue(() => props.drafts[props.name] ?? ""), (element) => (input = element)]}
        onInput={(event) => props.onDraft(props.name, event.currentTarget.value)}
      />
    </label>
  );
}

function AdvancedFilterFields(props: TranscriptsViewProps & { hint: string }) {
  return (
    <>
      <div class="transcripts-filters__advanced">
        <FilterField {...props} name="providerId" label={t("transcripts.sourceFilter")} />
        <FilterField {...props} name="accountId" label={t("transcripts.accountFilter")} />
        <FilterField {...props} name="agentId" label={t("transcripts.agentFilter")} />
        <FilterField
          {...props}
          name="startedAfter"
          label={t("transcripts.afterFilter")}
          type="date"
        />
        <FilterField
          {...props}
          name="startedBefore"
          label={t("transcripts.beforeFilter")}
          type="date"
        />
      </div>
      <p class="transcripts-caption">{props.hint}</p>
    </>
  );
}

export function Filters(props: TranscriptsViewProps & { phone: boolean }) {
  // The sheet stays inside the form, so its fields submit with the search field.
  let popover: PopoverHandle | undefined;
  const phoneSheet = createPhoneSheetLayout();
  // A memo, so route updates that leave the filters alone don't rewrite a toggled disclosure.
  const advancedActive = createMemo(() =>
    TRANSCRIPT_ADVANCED_FILTER_KEYS.some((key) => new URLSearchParams(props.search).get(key)),
  );
  const clear = () => {
    popover?.hide();
    props.onNavigate(
      Object.fromEntries([...TRANSCRIPT_FILTER_KEYS, "cursor"].map((key) => [key, null])),
    );
  };
  const triggerClass = () => ["btn transcripts-filters__trigger", { active: advancedActive() }];
  const panel = () => (
    <div class="transcripts-filter-popover__panel">
      <AdvancedFilterFields {...props} hint={t("transcripts.filterHintShort")} />
      <div class="transcripts-filter-popover__actions">
        <button type="button" class="btn" onClick={clear}>
          {t("transcripts.clearFilters")}
        </button>
        <button type="submit" class="btn primary">
          {t("transcripts.filter")}
        </button>
      </div>
    </div>
  );
  return (
    <form
      class={["transcripts-filters", { "transcripts-filters--phone": props.phone }]}
      aria-label={t("transcripts.filters")}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const patch: Record<string, string | null> = { cursor: null };
        for (const key of TRANSCRIPT_FILTER_KEYS) {
          patch[key] = normalizeNullableString(data.get(key));
        }
        popover?.hide();
        props.onNavigate(patch);
      }}
    >
      <FilterField
        {...props}
        name="query"
        label={t("transcripts.titleFilter")}
        compact={props.phone}
      />
      {props.phone ? (
        <Show
          when={phoneSheet()}
          fallback={
            <Popover
              id="transcripts-filter-popover"
              triggerClass={triggerClass()}
              trigger={<Icon name="listFilter" />}
              triggerTitle={t("transcripts.advancedFilters")}
              ref={(handle) => {
                popover = handle;
              }}
              label={t("transcripts.advancedFilters")}
              class="transcripts-filter-popover"
              placement="bottom-end"
              onOpenChange={(open) => {
                // Focus the surface, not the first field, so a tap doesn't raise the keyboard.
                if (open) {
                  popover?.overlay.surface.focus({ preventScroll: true });
                }
              }}
            >
              {panel()}
            </Popover>
          }
        >
          <PhoneSheet
            id="transcripts-filter-popover"
            triggerClass={triggerClass()}
            trigger={<Icon name="listFilter" />}
            triggerTitle={t("transcripts.advancedFilters")}
            ref={(handle) => {
              popover = handle;
            }}
            label={t("transcripts.advancedFilters")}
            class="transcripts-filter-popover"
          >
            {panel()}
          </PhoneSheet>
        </Show>
      ) : (
        <>
          <details open={advancedActive()}>
            <summary>{t("transcripts.advancedFilters")}</summary>
            <AdvancedFilterFields {...props} hint={t("transcripts.filterHint")} />
          </details>
          <div class="transcripts-actions">
            <button type="submit" class="btn">
              <Icon name="search" />
              {t("transcripts.filter")}
            </button>
            <button type="button" class="btn" onClick={clear}>
              {t("transcripts.clearFilters")}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
