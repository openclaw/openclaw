import type { JSX } from "@solidjs/web";
import { createMemo, Match, Show, Switch } from "solid-js";
import { objectFormOfUnion } from "../lib/config-form-utils.ts";
import { getLocale, t } from "../lib/reactive/i18n.ts";
import { resolveStructuredDraftInitialValue } from "./config-form-structured-draft.ts";
import { ConfigStructuredDraft } from "./config-form-structured-draft.tsx";
import { configLabelInContext } from "./config-form.label-context.ts";
import { ConfigArray, ConfigObject } from "./config-form.node.collection.tsx";
import { NumberInput, SelectInput, TextInput } from "./config-form.node.scalar.tsx";
import {
  configEnumOptionLabel,
  getSensitiveRenderState,
  jsonValue,
  isAnySchema,
  isSecretRefObject,
  resolveConfigFieldPresentation,
  type ConfigNodeRenderParams,
  type ConfigNodeRenderer,
} from "./config-form.node.shared.ts";
import {
  ConfigFieldHelp,
  configRowCopy,
  FieldRow,
  JsonTextareaControl,
  schemaDefaultValueText,
  SegmentedControl,
} from "./config-form.node.shared.tsx";
import {
  hasConfigSearchCriteria,
  matchesNodeSearch,
  resolveConfigFieldMeta,
} from "./config-form.search.ts";
import { hintForPath, pathKey, schemaType, type JsonSchema } from "./config-form.shared.ts";
import { SettingsToggle, SettingsToggleRow } from "./solid/settings-ui.tsx";

// Past this a segmented control stops fitting the control column at a readable size.
const SEGMENTED_MAX_OPTIONS = 3;
const SEGMENTED_MAX_LABEL_CHARS = 12;

function fitsSegmentedControl(options: readonly unknown[]): boolean {
  return (
    options.length <= SEGMENTED_MAX_OPTIONS &&
    options.every(
      (option) => configEnumOptionLabel(option, options).length <= SEGMENTED_MAX_LABEL_CHARS,
    )
  );
}
const isConfigObjectValue = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function resolveNode(
  schema: JsonSchema,
  params: ConfigNodeRenderParams,
): {
  schema: JsonSchema;
  kind: "options" | "text" | "number" | "boolean" | "object" | "array" | "json" | "unsupported";
  options?: unknown[];
  nullable?: boolean;
  inputType?: "text" | "number";
  shorthandObject?: boolean;
} {
  if (schema.anyOf || schema.oneOf) {
    const nonNull = (schema.anyOf ?? schema.oneOf ?? []).filter(
      (variant) =>
        !(
          variant.type === "null" ||
          (Array.isArray(variant.type) && variant.type.includes("null"))
        ),
    );
    if (nonNull.length === 1 && nonNull[0]) {
      return resolveNode(nonNull[0], params);
    }
    const literals = nonNull.map((variant) =>
      variant.const !== undefined
        ? variant.const
        : variant.enum?.length === 1
          ? variant.enum[0]
          : undefined,
    );
    if (literals.length && literals.every((literal) => literal !== undefined)) {
      return { schema, kind: "options", options: literals };
    }
    const types = new Set(
      nonNull.flatMap((variant) => {
        const type = schemaType(variant);
        return type ? [type === "integer" ? "number" : type] : [];
      }),
    );
    if (
      params.maskSensitive === true &&
      Array.isArray(schema.type) &&
      types.size === 2 &&
      types.has("string") &&
      types.has("object") &&
      (params.value === undefined ||
        typeof params.value === "string" ||
        isSecretRefObject(params.value))
    ) {
      return { schema, kind: "text", inputType: "text" };
    }
    if ([...types].every((type) => ["string", "number", "boolean"].includes(type))) {
      if (types.has("boolean") && types.size === 1) {
        return {
          schema: { ...schema, type: "boolean", anyOf: undefined, oneOf: undefined },
          kind: "boolean",
        };
      }
      if (types.has("string") || types.has("number")) {
        return {
          schema,
          kind: "text",
          inputType: types.has("number") && !types.has("string") ? "number" : "text",
        };
      }
    }
    const objectForm = objectFormOfUnion(schema);
    if (
      objectForm &&
      (params.value === undefined ||
        typeof params.value === "string" ||
        isConfigObjectValue(params.value))
    ) {
      return {
        schema: { ...schema, ...objectForm, anyOf: undefined, oneOf: undefined },
        kind: "object",
        shorthandObject: true,
      };
    }
    return { schema, kind: "json" };
  }
  if (schema.enum) {
    return {
      schema,
      kind: "options",
      options: schema.enum,
      nullable: schema.nullable && schema.enumIncludesNull,
    };
  }
  const type = schemaType(schema);
  if (type === "object" || type === "array" || type === "boolean") {
    return { schema, kind: type };
  }
  if (type === "number" || type === "integer") {
    return { schema, kind: "number" };
  }
  if (type === "string") {
    return { schema, kind: "text", inputType: "text" };
  }
  return { schema, kind: isAnySchema(schema) ? "json" : "unsupported" };
}

export function ConfigNode(props: { params: ConfigNodeRenderParams }): JSX.Element {
  const node = createMemo(() => resolveNode(props.params.schema, props.params));
  const params = createMemo(() => ({
    ...props.params,
    schema: node().schema,
    shorthandObject: node().shorthandObject,
  }));
  const meta = createMemo(
    () => {
      getLocale();
      return resolveConfigFieldMeta(params().path, params().schema, params().hints);
    },
    { lazy: true },
  );
  const unsupported = createMemo(() => {
    const path = params().path;
    return (
      params().unsupported.has(pathKey(path)) ||
      [...params().unsupported].some((pattern) => {
        const segments = pattern.split(".");
        return (
          pattern.includes("*") &&
          segments.length === path.length &&
          segments.every((segment, index) => segment === "*" || segment === String(path[index]))
        );
      })
    );
  });
  const matches = createMemo(
    () =>
      !params().searchCriteria ||
      !hasConfigSearchCriteria(params().searchCriteria!) ||
      matchesNodeSearch({ ...params(), criteria: params().searchCriteria! }),
  );
  const draftInputs = createMemo(
    () => ({
      schema: params().schema,
      value: params().value,
      isRequired: params().isRequired,
      structuredDraftOwner: params().structuredDraftOwner,
    }),
    {
      equals: (previous, next) =>
        previous.schema === next.schema &&
        Object.is(previous.value, next.value) &&
        previous.isRequired === next.isRequired &&
        previous.structuredDraftOwner === next.structuredDraftOwner,
    },
  );
  const initialDraft = createMemo(() => resolveStructuredDraftInitialValue(draftInputs()));
  return (
    <Switch>
      <Match when={unsupported()}>
        <FieldRow
          label={meta().label}
          showLabel
          control={undefined}
          unsupported={t("configForm.unsupportedNode")}
          onOpenRaw={params().onOpenRaw}
        />
      </Match>
      <Match when={matches()}>
        <Show
          when={initialDraft() !== undefined}
          fallback={<ResolvedNode params={params()} node={node()} />}
        >
          <ConfigStructuredDraft
            class="cfg-structured-draft"
            identity={JSON.stringify(
              params().path.filter((segment) => typeof segment === "string"),
            )}
            sourceIdentity={params().sourceIdentity ?? params().value}
            initialValue={initialDraft()!}
            params={params()}
            renderNode={renderNode}
          />
        </Show>
      </Match>
    </Switch>
  );
}

function ResolvedNode(props: {
  params: ConfigNodeRenderParams;
  node: ReturnType<typeof resolveNode>;
}): JSX.Element {
  const field = createMemo(
    () => {
      getLocale();
      return resolveConfigFieldPresentation(props.params);
    },
    { lazy: true },
  );
  return (
    <Switch
      fallback={
        <FieldRow
          label={field().label}
          showLabel
          control={undefined}
          unsupported={t("configForm.unsupportedType", {
            type: String(schemaType(props.params.schema)),
          })}
          onOpenRaw={props.params.onOpenRaw}
        />
      }
    >
      <Match when={props.node.kind === "options"}>
        <Show
          when={!fitsSegmentedControl(props.node.options ?? []) || props.node.nullable}
          fallback={
            <FieldRow
              {...field()}
              defaultValue={schemaDefaultValueText(props.params.schema)}
              control={
                <SegmentedControl
                  options={props.node.options ?? []}
                  resolvedValue={
                    props.params.value !== undefined
                      ? props.params.value
                      : props.params.schema.default
                  }
                  disabled={props.params.disabled}
                  required={field().required}
                  ariaLabel={field().label}
                  descriptionId={props.params.descriptionId}
                  onSelect={(option) => props.params.onPatch(props.params.path, option)}
                />
              }
            />
          }
        >
          <SelectInput params={{ ...props.params, options: props.node.options ?? [] }} />
        </Show>
      </Match>
      <Match when={props.node.kind === "object"}>
        <ConfigObject params={props.params} renderNode={renderNode} />
      </Match>
      <Match when={props.node.kind === "array"}>
        <ConfigArray params={props.params} renderNode={renderNode} />
      </Match>
      <Match when={props.node.kind === "boolean"}>
        <BooleanNode params={props.params} />
      </Match>
      <Match when={props.node.kind === "number"}>
        <NumberInput params={props.params} />
      </Match>
      <Match when={props.node.kind === "text"}>
        <TextInput params={{ ...props.params, inputType: props.node.inputType ?? "text" }} />
      </Match>
      <Match when={props.node.kind === "json"}>
        <JsonTextarea params={props.params} />
      </Match>
    </Switch>
  );
}

function JsonTextarea(props: { params: ConfigNodeRenderParams }): JSX.Element {
  const field = createMemo(() => {
    getLocale();
    return resolveConfigFieldPresentation(props.params);
  });
  const sensitiveState = createMemo(() => getSensitiveRenderState(props.params));
  return (
    <FieldRow
      {...field()}
      defaultValue={
        sensitiveState().isRedacted ? undefined : schemaDefaultValueText(props.params.schema)
      }
      stacked
      control={
        <JsonTextareaControl
          schema={props.params.schema}
          path={props.params.path}
          ariaLabel={field().label}
          descriptionId={field().helpId}
          sourceValue={props.params.sourceIdentity ?? props.params.value}
          fallback={jsonValue(
            props.params.value !== undefined ? props.params.value : props.params.schema.default,
          )}
          rows={3}
          sensitiveState={sensitiveState()}
          disabled={props.params.disabled}
          isRequired={props.params.isRequired}
          showRequiredCue={false}
          onToggleSensitivePath={props.params.onToggleSensitivePath}
          hints={props.params.hints}
          secretFields={props.params.secretFields}
          onPatch={props.params.onPatch}
        />
      }
    />
  );
}

function BooleanNode(props: { params: ConfigNodeRenderParams }): JSX.Element {
  const meta = createMemo(() => {
    getLocale();
    return resolveConfigFieldMeta(props.params.path, props.params.schema, props.params.hints);
  });
  const checked = () =>
    typeof props.params.value === "boolean"
      ? props.params.value
      : typeof props.params.schema.default === "boolean"
        ? props.params.schema.default
        : false;
  const onChange = (value: boolean) => props.params.onPatch(props.params.path, value);
  const defaultValue = createMemo(() => schemaDefaultValueText(props.params.schema));
  const copy = createMemo(() =>
    configRowCopy({
      label: meta().label,
      help: meta().help,
      context: props.params.helpContext,
      defaultValue: defaultValue(),
    }),
  );
  return (
    <Switch
      fallback={
        <FieldRow
          label={meta().label}
          help={meta().help}
          showLabel={false}
          control={
            <SettingsToggle
              checked={checked()}
              disabled={props.params.disabled}
              ariaLabel={meta().label}
              onChange={onChange}
            />
          }
        />
      }
    >
      <Match
        when={
          !props.params.isRequired &&
          hintForPath(props.params.path, props.params.hints)?.placeholder
        }
      >
        <SelectInput params={{ ...props.params, options: [true, false] }} />
      </Match>
      <Match when={props.params.compact}>
        <FieldRow
          label={meta().label}
          title={configLabelInContext(meta().label, props.params.contextLabel)}
          path={props.params.path}
          help={meta().help}
          helpContext={props.params.helpContext}
          showLabel={props.params.showLabel ?? true}
          control={
            <input
              type="checkbox"
              aria-label={meta().label}
              aria-describedby={props.params.descriptionId}
              checked={checked()}
              disabled={props.params.disabled}
              onChange={(event) => {
                if (onChange(event.currentTarget.checked) === false) {
                  event.currentTarget.checked = checked();
                }
              }}
            />
          }
        />
      </Match>
      <Match when={props.params.showLabel !== false}>
        <SettingsToggleRow
          title={
            <>
              {configLabelInContext(meta().label, props.params.contextLabel)}
              <Show when={copy().hasHelp}>
                <ConfigFieldHelp
                  path={props.params.path}
                  label={meta().label}
                  help={meta().help}
                  context={props.params.helpContext}
                  defaultValue={defaultValue()}
                />
              </Show>
            </>
          }
          ariaLabel={meta().label}
          description={
            copy().summary ? <span class="config-field__summary">{copy().summary}</span> : undefined
          }
          checked={checked()}
          disabled={props.params.disabled}
          onChange={onChange}
        />
      </Match>
    </Switch>
  );
}

export const renderNode: ConfigNodeRenderer = (params) => <ConfigNode params={params()} />;
