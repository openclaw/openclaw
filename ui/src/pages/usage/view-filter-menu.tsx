import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { For, Show, createMemo } from "solid-js";
import type { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import { Icon } from "../../components/solid/icon.tsx";
import {
  Menu,
  createMenuControls,
  type MenuEntry,
  type MenuItem,
  type MenuHandle,
} from "../../components/solid/menu.tsx";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../lib/ime.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { applySuggestionToQuery, removeQueryToken, setQueryTokensForKey } from "./query.ts";
import type { UsageProps } from "./types.ts";
import { usageCreatorOptions } from "./view-creators.tsx";
import {
  toggleUsageQueryValue,
  usageQueryFieldOptions,
  usageQueryFieldValues,
  usageQueryFilterSearchLabel,
  type UsageQueryFilterKey,
} from "./view-query-filter.tsx";
import {
  createUsageValuePicker,
  UsageValuePicker,
  type UsageValuePickerConfig,
} from "./view-value-picker.tsx";

type QueryTerms = ReturnType<typeof extractQueryTerms>;
type FieldKey = "creator" | UsageQueryFilterKey;
const QUERY_FIELDS = ["channel", "provider", "model", "tool"] as const;
const FIELDS: readonly FieldKey[] = ["creator", ...QUERY_FIELDS];
const FIELD_ICONS = {
  creator: "users",
  channel: "messageCircle",
  provider: "cloud",
  model: "box",
  tool: "wrench",
} as const;

type UsageFilterContext = {
  props: UsageProps;
  queryTerms: () => QueryTerms;
  viewerId: () => string | null;
  filterOptions: () => Record<UsageQueryFilterKey, string[]>;
  counts: (key: UsageQueryFilterKey) => Readonly<Record<string, number>> | undefined;
  suggestions: () => { label: string; value: string }[];
};

type UsageFilterField = Omit<UsageValuePickerConfig, "id" | "controls"> & {
  key: FieldKey;
  label: () => string;
  selected: () => string[];
};

const isHasErrors = (term: QueryTerms[number]) =>
  normalizeLowercaseStringOrEmpty(term.key ?? "") === "has" &&
  normalizeLowercaseStringOrEmpty(term.value) === "errors";

/** Every value field the Filter menu and the chips share: Started by plus the query facets. */
export function createUsageFilterFields(ctx: UsageFilterContext) {
  const filters = () => ctx.props.callbacks.filters;
  const creatorOptions = createMemo(() =>
    usageCreatorOptions(
      ctx.props.data.creatorOptions,
      ctx.props.filters.creatorKey,
      ctx.viewerId(),
    ),
  );
  const creator: UsageFilterField = {
    key: "creator",
    label: () => t("usage.creators.title"),
    multiple: false,
    options: creatorOptions,
    selected: () => (ctx.props.filters.creatorKey === null ? [] : [ctx.props.filters.creatorKey]),
    isSelected: (value) => value === ctx.props.filters.creatorKey,
    searchLabel: () => t("usage.filters.search.creator"),
    onToggle: (value) =>
      filters().onScopeChange({
        creatorKey: value === ctx.props.filters.creatorKey ? null : value,
      }),
    onClear: () => filters().onScopeChange({ creatorKey: null }),
  };
  const queryField = (key: UsageQueryFilterKey): UsageFilterField => {
    const selected = createMemo(() => usageQueryFieldValues(ctx.queryTerms(), key));
    const selectedSet = createMemo(
      () => new Set(selected().map((value) => normalizeLowercaseStringOrEmpty(value))),
    );
    const draft = () => ctx.props.filters.queryDraft;
    return {
      key,
      label: () => t(`usage.filters.${key}`),
      multiple: true,
      options: createMemo(() =>
        usageQueryFieldOptions(ctx.filterOptions()[key], ctx.counts(key), selected()),
      ),
      selected,
      isSelected: (value) => selectedSet().has(normalizeLowercaseStringOrEmpty(value)),
      searchLabel: () => usageQueryFilterSearchLabel(key),
      onToggle: (value) =>
        filters().onQueryDraftChange(toggleUsageQueryValue(draft(), key, selected(), value)),
      onClear: () => filters().onQueryDraftChange(setQueryTokensForKey(draft(), key, [])),
      onSelectAll: (values) =>
        filters().onQueryDraftChange(
          setQueryTokensForKey(draft(), key, [
            ...selected(),
            ...values.filter((value) => !selectedSet().has(normalizeLowercaseStringOrEmpty(value))),
          ]),
        ),
    };
  };
  const fields: Record<FieldKey, UsageFilterField> = {
    creator,
    channel: queryField("channel"),
    provider: queryField("provider"),
    model: queryField("model"),
    tool: queryField("tool"),
  };
  const hasErrors = () => ctx.queryTerms().some(isHasErrors);
  const toggleHasErrors = () => {
    const draft = ctx.props.filters.queryDraft;
    const values = usageQueryFieldValues(ctx.queryTerms(), "has");
    filters().onQueryDraftChange(
      setQueryTokensForKey(
        draft,
        "has",
        hasErrors()
          ? values.filter((value) => normalizeLowercaseStringOrEmpty(value) !== "errors")
          : [...values, "errors"],
      ),
    );
  };
  // Free text and keys without a picker stay as their own query-term chips.
  const otherTerms = createMemo(() =>
    ctx
      .queryTerms()
      .filter(
        (term) =>
          !isHasErrors(term) &&
          !QUERY_FIELDS.some((key) => key === normalizeLowercaseStringOrEmpty(term.key ?? "")),
      ),
  );
  return { ctx, fields, hasErrors, toggleHasErrors, otherTerms };
}

type UsageFilterFields = ReturnType<typeof createUsageFilterFields>;

/** One Filter menu: the query on top, then a searchable submenu per field, then Has errors. */
export function UsageFilterMenu(props: { model: UsageFilterFields; loading: boolean }) {
  const controls = createMenuControls();
  const filters = () => props.model.ctx.props.callbacks.filters;
  let menu: MenuHandle | undefined;
  const picker = (key: FieldKey) =>
    createUsageValuePicker({ ...props.model.fields[key], id: `filter-${key}`, controls }, () =>
      menu?.close(),
    );
  const pickers = {
    creator: picker("creator"),
    channel: picker("channel"),
    provider: picker("provider"),
    model: picker("model"),
    tool: picker("tool"),
  };
  const queryKeydown = nativeListener("keydown", (event) => {
    if (event.key === "Enter" && !isComposingKeyboardEvent(event)) {
      event.preventDefault();
      event.stopPropagation();
      filters().onApplyQuery();
    }
  });
  const queryEntry: MenuEntry = {
    kind: "content",
    id: "query",
    content: (
      <div class="usage-filter-menu__query">
        <Icon name="search" />
        <input
          ref={[controls.ref(), queryKeydown]}
          type="text"
          data-form-control=""
          data-initial-focus=""
          autocomplete="off"
          spellcheck="false"
          aria-label={t("usage.query.placeholder")}
          title={t("usage.query.placeholder")}
          placeholder={t("usage.query.short")}
          value={props.model.ctx.props.filters.queryDraft}
          onBlur={clearCompositionEnd}
          onCompositionEnd={recordCompositionEnd}
          onKeyUp={clearCompositionEnd}
          onInput={(event) => filters().onQueryDraftChange(event.currentTarget.value)}
          // Opening the menu continues the query where it ends.
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
        />
      </div>
    ),
  };
  const selectedDetail = (key: FieldKey) => {
    const field = props.model.fields[key];
    const selected = field.selected();
    if (!selected.length) {
      return undefined;
    }
    const label =
      selected.length > 1
        ? String(selected.length)
        : (field.options().find((option) => option.value === selected[0])?.label ?? selected[0]);
    return <span class="usage-filter-menu__value">{label}</span>;
  };
  const items = createMemo((): MenuEntry[] => [
    queryEntry,
    // Suggestions complete the token being typed; a finished query (trailing space) shows none.
    ...(/\S$/u.test(props.model.ctx.props.filters.queryDraft)
      ? props.model.ctx.suggestions()
      : []
    ).map((suggestion): MenuItem => ({
      id: `suggest:${suggestion.value}`,
      label: suggestion.label,
      class: "usage-filter-menu__suggestion",
      closeOnSelect: false,
    })),
    { kind: "content", id: "query-end", content: <div role="separator" /> },
    ...FIELDS.map((key): MenuItem => ({
      id: `field:${key}`,
      label: props.model.fields[key].label(),
      icon: <Icon name={FIELD_ICONS[key]} />,
      details: selectedDetail(key),
      class: "usage-filter-menu__field",
      onBeforeShow: () => pickers[key].reset(),
      children: () => pickers[key].entries(),
    })),
    { kind: "content", id: "fields-end", content: <div role="separator" /> },
    {
      id: "has-errors",
      label: t("usage.filters.hasErrors"),
      icon: <Icon name="alertTriangle" />,
      type: "checkbox",
      checked: props.model.hasErrors(),
      closeOnSelect: false,
      class: "usage-filter-menu__field",
    },
  ]);
  return (
    <Menu
      ref={(handle) => {
        menu = handle;
      }}
      id="usage-filter-menu"
      lazy
      label={t("usage.filters.title")}
      class="usage-filter-menu"
      panelClass="usage-filter-menu__panel"
      triggerClass="btn btn--sm btn--icon usage-filter-menu__trigger"
      triggerAttributes={{ title: t("usage.filters.title") }}
      placement="bottom-end"
      controls={controls}
      items={items()}
      onSelect={(item) => {
        if (item.id === "has-errors") {
          props.model.toggleHasErrors();
        } else if (item.id.startsWith("suggest:")) {
          filters().onQueryDraftChange(
            applySuggestionToQuery(
              props.model.ctx.props.filters.queryDraft,
              item.id.slice("suggest:".length),
            ),
          );
        } else {
          FIELDS.some((key) => pickers[key].select(item));
        }
      }}
      trigger={<Icon name="listFilter" />}
    />
  );
}

/** Applied filters in their own row: one chip per field, then Has errors and query terms. */
export function UsageAppliedFilters(props: {
  model: UsageFilterFields;
  count: () => string | undefined;
}) {
  const filters = () => props.model.ctx.props.callbacks.filters;
  const applied = (key: FieldKey) => props.model.fields[key].selected().length > 0;
  const any = () =>
    FIELDS.some(applied) || props.model.hasErrors() || props.model.otherTerms().length > 0;
  const removeButton = (label: string, remove: () => void) => (
    <button
      type="button"
      class="usage-filter-chip__remove"
      aria-label={`${t("usage.filters.remove")}: ${label}`}
      title={t("usage.filters.remove")}
      onClick={remove}
    >
      <Icon name="x" />
    </button>
  );
  const FieldChip = (chip: { key: FieldKey }) => {
    const field = props.model.fields[chip.key];
    const values = () => field.selected();
    const valueLabel = () =>
      values().length > 1
        ? String(values().length)
        : (field.options().find((option) => option.value === values()[0])?.label ??
          values()[0] ??
          "");
    const names = () =>
      values()
        .map((value) => field.options().find((option) => option.value === value)?.label ?? value)
        .join(", ");
    return (
      <span class="usage-filter-chip" title={names()}>
        <UsageValuePicker
          {...field}
          id={`chip-${chip.key}`}
          label={`${field.label()}: ${names()}`}
          triggerClass="usage-filter-chip__open"
          placement="bottom-start"
          trigger={
            <>
              <span class="usage-filter-chip__key">{field.label()}</span>
              <span class="usage-filter-chip__op">
                {values().length > 1 ? t("usage.filters.isAnyOf") : t("usage.filters.is")}
              </span>
              <span class="usage-filter-chip__value">{valueLabel()}</span>
            </>
          }
        />
        {removeButton(field.label(), field.onClear)}
      </span>
    );
  };
  return (
    <Show when={any()}>
      <div class="usage-applied-row">
        <For each={FIELDS.filter(applied)}>{(key) => <FieldChip key={key} />}</For>
        <Show when={props.model.hasErrors()}>
          <span class="usage-filter-chip usage-filter-chip--plain">
            <span class="usage-filter-chip__value">{t("usage.filters.hasErrors")}</span>
            {removeButton(t("usage.filters.hasErrors"), props.model.toggleHasErrors)}
          </span>
        </Show>
        <For each={props.model.otherTerms()}>
          {(term) => (
            <span class="usage-filter-chip usage-filter-chip--plain">
              <span class="usage-filter-chip__value usage-filter-chip__value--code">
                {term.raw}
              </span>
              {removeButton(term.raw, () =>
                filters().onQueryDraftChange(
                  removeQueryToken(props.model.ctx.props.filters.queryDraft, term.raw),
                ),
              )}
            </span>
          )}
        </For>
        <button
          type="button"
          class="usage-applied-row__clear"
          onClick={() => {
            filters().onClearQuery();
            if (props.model.ctx.props.filters.creatorKey !== null) {
              filters().onScopeChange({ creatorKey: null });
            }
          }}
        >
          {t("usage.filters.clearAll")}
        </button>
        <span class="usage-applied-row__count">{props.count()}</span>
      </div>
    </Show>
  );
}
