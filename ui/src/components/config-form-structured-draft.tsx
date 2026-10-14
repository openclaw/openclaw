import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { copyWithPathPatch } from "./config-form-copy-on-write.ts";
import type { ConfigFormStructuredDraftProps } from "./config-form-structured-draft.ts";
import { isSupportedConfigValueValid } from "./config-form.constraints.ts";
import { configFieldId, schemaType } from "./config-form.shared.ts";

export function ConfigStructuredDraft(
  props: ConfigFormStructuredDraftProps & { class?: string },
): SolidJSX.Element {
  const [draftValue, setDraftValue] = createSignal(
    untrack(() => structuredClone(props.initialValue)),
  );
  const [error, setError] = createSignal("");
  let previous = untrack(() => [props.identity, props.sourceIdentity] as const);
  createEffect(
    () => [props.identity, props.sourceIdentity, props.initialValue] as const,
    (next) => {
      if (previous[0] !== next[0] || !Object.is(previous[1], next[1])) {
        setDraftValue(structuredClone(next[2]));
        setError("");
      }
      previous = [next[0], next[1]];
    },
  );
  const patchDraft = (path: Array<string | number>, value: unknown): boolean => {
    const current = draftValue();
    const rootPath = props.params.path;
    if (
      path.length < rootPath.length ||
      !rootPath.every((segment, index) => segment === path[index])
    ) {
      return false;
    }
    const patched = copyWithPathPatch(current, path.slice(rootPath.length), value);
    if (!patched.ok) {
      return false;
    }
    const candidate = patched.value;
    const type = schemaType(props.params.schema);
    if (
      (type === "object" && !isRecord(candidate)) ||
      (type === "array" && !Array.isArray(candidate))
    ) {
      return false;
    }
    // SAFETY: Structured drafts have object/array schemas, and the checks above preserve that root kind.
    setDraftValue(candidate as Record<string, unknown> | unknown[]);
    setError("");
    if (!isSupportedConfigValueValid(props.params.schema, candidate)) {
      return true;
    }
    if (props.params.onPatch(rootPath, candidate) !== false) {
      return true;
    }
    setError(t("configForm.draftRejected"));
    return false;
  };
  return (
    <openclaw-config-form-structured-draft class={props.class}>
      {props.renderNode(() => ({
        ...props.params,
        value: draftValue(),
        sourceIdentity: draftValue(),
        controlIdentity: draftValue(),
        structuredDraftOwner: true,
        onPatch: patchDraft,
        onRemove: (path) => patchDraft(path, undefined),
      }))}
      <Show when={error()}>
        <div class="settings-row settings-row--stacked cfg-structured-draft__error">
          <div class="settings-row__control">
            <span
              id={configFieldId(props.params.path, "structured-draft-error")}
              class="cfg-field__error"
              role="alert"
            >
              {error()}
            </span>
          </div>
        </div>
      </Show>
    </openclaw-config-form-structured-draft>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-config-form-structured-draft": HTMLAttributes<HTMLElement>;
    }
  }
}
