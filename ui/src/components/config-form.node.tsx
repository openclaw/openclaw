import type { JSX } from "@solidjs/web";
import { createMemo, Match, Show, Switch } from "solid-js";
import { getLocale, t } from "../lib/reactive/i18n.ts";
import { resolveStructuredDraftInitialValue } from "./config-form-structured-draft.ts";
import { ConfigStructuredDraftHost } from "./config-form.bridge.tsx";
import { ConfigArray, ConfigObject } from "./config-form.node.collection.tsx";
import { JsonTextarea } from "./config-form.node.json.tsx";
import { NumberInput, SelectInput, TextInput } from "./config-form.node.scalar.tsx";
import {
  isAnySchema,
  isSecretRefObject,
  type ConfigNodeRenderParams,
  type ConfigNodeRenderer,
} from "./config-form.node.shared.ts";
import {
  FieldRow,
  SegmentedControl,
  renderSchemaDefaultDescription,
} from "./config-form.node.shared.tsx";
import {
  hasConfigSearchCriteria,
  matchesNodeSearch,
  resolveConfigFieldMeta,
} from "./config-form.search.ts";
import { hintForPath, pathKey, schemaType, type JsonSchema } from "./config-form.shared.ts";
import { SettingsToggle, SettingsToggleRow } from "./solid/settings-ui.tsx";

function resolveNode(
  schema: JsonSchema,
  params: ConfigNodeRenderParams,
): {
  schema: JsonSchema;
  kind: "options" | "text" | "number" | "boolean" | "object" | "array" | "json" | "unsupported";
  options?: unknown[];
  nullable?: boolean;
  inputType?: "text" | "number";
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
  const params = createMemo(() => ({ ...props.params, schema: node().schema }));
  const meta = createMemo(() => {
    getLocale();
    return resolveConfigFieldMeta(params().path, params().schema, params().hints);
  });
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
  const initialDraft = createMemo(() => resolveStructuredDraftInitialValue(params()));
  return (
    <Switch>
      <Match when={unsupported()}>
        <FieldRow
          label={meta().label}
          showLabel
          control={undefined}
          error={t("configForm.unsupportedNode")}
        />
      </Match>
      <Match when={matches()}>
        <Show
          when={initialDraft() !== undefined}
          fallback={<ResolvedNode params={params()} node={node()} />}
        >
          <ConfigStructuredDraftHost
            class="cfg-structured-draft"
            props={{
              identity: JSON.stringify(
                params().path.filter((segment) => typeof segment === "string"),
              ),
              sourceIdentity: params().sourceIdentity ?? params().value,
              initialValue: initialDraft()!,
              params: params(),
              renderSolidNode: renderNode,
            }}
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
  const meta = createMemo(() => {
    getLocale();
    return resolveConfigFieldMeta(props.params.path, props.params.schema, props.params.hints);
  });
  return (
    <Switch
      fallback={
        <FieldRow
          label={meta().label}
          showLabel
          control={undefined}
          error={t("configForm.unsupportedType", { type: String(schemaType(props.params.schema)) })}
        />
      }
    >
      <Match when={props.node.kind === "options"}>
        <Show
          when={(props.node.options?.length ?? 0) > 5 || props.node.nullable}
          fallback={
            <FieldRow
              label={meta().label}
              help={meta().help}
              showLabel={props.params.showLabel ?? true}
              defaultDescription={renderSchemaDefaultDescription(
                props.params.schema,
                props.params.value,
              )}
              control={
                <SegmentedControl
                  options={props.node.options ?? []}
                  resolvedValue={
                    props.params.value !== undefined
                      ? props.params.value
                      : props.params.schema.default
                  }
                  disabled={props.params.disabled}
                  ariaLabel={meta().label}
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
  return (
    <Show
      when={
        !props.params.isRequired && hintForPath(props.params.path, props.params.hints)?.placeholder
      }
      fallback={
        <Show
          when={props.params.compact}
          fallback={
            <Show
              when={props.params.showLabel !== false}
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
              <SettingsToggleRow
                title={meta().label}
                description={
                  <>
                    {meta().help}
                    <Show when={meta().help && props.params.schema.default !== undefined}>
                      <br />
                    </Show>
                    {renderSchemaDefaultDescription(props.params.schema, props.params.value)}
                  </>
                }
                checked={checked()}
                disabled={props.params.disabled}
                onChange={onChange}
              />
            </Show>
          }
        >
          <FieldRow
            label={meta().label}
            help={meta().help}
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
        </Show>
      }
    >
      <SelectInput params={{ ...props.params, options: [true, false] }} />
    </Show>
  );
}

export const renderNode: ConfigNodeRenderer = (params) => <ConfigNode params={params()} />;
