import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
import { copyWithPathPatch } from "../lib/config-form-utils.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { ConfigFormStructuredDraftProps } from "./config-form-structured-draft.ts";
import { isSupportedConfigValueValid } from "./config-form.constraints.ts";
import { configFieldId, schemaType } from "./config-form.shared.ts";

export function ConfigStructuredDraft(
  props: ConfigFormStructuredDraftProps & { class?: string },
): SolidJSX.Element {
  const scope = createMemo(
    () => ({
      identity: props.identity,
      sourceIdentity: props.sourceIdentity,
      initialValue: props.initialValue,
    }),
    {
      equals: (previous, next) =>
        previous.identity === next.identity &&
        Object.is(previous.sourceIdentity, next.sourceIdentity),
    },
  );
  // Edits own this value until the identity changes, regardless of refreshed defaults.
  const [draft, setDraft] = createSignal(() => ({ value: scope().initialValue, error: "" }));
  const patchDraft = (path: Array<string | number>, value: unknown): boolean => {
    const current = draft().value;
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
    setDraft({ value: candidate as Record<string, unknown> | unknown[], error: "" });
    if (!isSupportedConfigValueValid(props.params.schema, candidate)) {
      return true;
    }
    if (props.params.onPatch(rootPath, candidate) !== false) {
      return true;
    }
    setDraft((state) => ({ ...state, error: t("configForm.draftRejected") }));
    return false;
  };
  return (
    <openclaw-config-form-structured-draft class={props.class}>
      {props.renderNode(() => ({
        ...props.params,
        value: draft().value,
        sourceIdentity: draft().value,
        controlIdentity: draft().value,
        structuredDraftOwner: true,
        onPatch: patchDraft,
        onRemove: (path) => patchDraft(path, undefined),
      }))}
      <Show when={draft().error}>
        <div class="settings-row settings-row--stacked cfg-structured-draft__error">
          <div class="settings-row__control">
            <span
              id={configFieldId(props.params.path, "structured-draft-error")}
              class="cfg-field__error"
              role="alert"
            >
              {draft().error}
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
