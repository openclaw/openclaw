import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { copyWithPathPatch } from "./config-form-copy-on-write.ts";
import { isSupportedConfigValueValid } from "./config-form.constraints.ts";
import type { ConfigNodeRenderer, ConfigNodeRenderParams } from "./config-form.node.shared.ts";
import { configFieldId, schemaType } from "./config-form.shared.ts";

export type ConfigFormStructuredDraftProps = {
  identity: string;
  sourceIdentity: unknown;
  initialValue: Record<string, unknown> | unknown[];
  params: ConfigNodeRenderParams;
  renderNode: ConfigNodeRenderer;
};

export function ConfigFormStructuredDraftContent(props: {
  props?: ConfigFormStructuredDraftProps;
}): JSX.Element {
  const [draftValue, setDraftValue] = createSignal<Record<string, unknown> | unknown[] | undefined>(
    untrack(() => props.props && structuredClone(props.props.initialValue)),
  );
  const [error, setError] = createSignal("");
  let previous = untrack(() => props.props);
  createEffect(
    () => props.props,
    (next) => {
      if (
        next &&
        (!previous ||
          previous.identity !== next.identity ||
          !Object.is(previous.sourceIdentity, next.sourceIdentity))
      ) {
        setDraftValue(structuredClone(next.initialValue));
        setError("");
      }
      previous = next;
    },
  );
  const patchDraft = (path: Array<string | number>, value: unknown): boolean => {
    const currentProps = props.props;
    const current = draftValue();
    if (!currentProps || !current) {
      return false;
    }
    const rootPath = currentProps.params.path;
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
    const type = schemaType(currentProps.params.schema);
    if (
      (type === "object" && !isRecord(candidate)) ||
      (type === "array" && !Array.isArray(candidate))
    ) {
      return false;
    }
    // SAFETY: Structured drafts have object/array schemas, and the checks above preserve that root kind.
    setDraftValue(candidate as Record<string, unknown> | unknown[]);
    setError("");
    if (!isSupportedConfigValueValid(currentProps.params.schema, candidate)) {
      return true;
    }
    if (currentProps.params.onPatch(rootPath, candidate) !== false) {
      return true;
    }
    setError(t("configForm.draftRejected"));
    return false;
  };
  return (
    <Show when={props.props && draftValue()}>
      {(_draft) => (
        <>
          {props.props!.renderNode(() => ({
            ...props.props!.params,
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
                  id={configFieldId(props.props!.params.path, "structured-draft-error")}
                  class="cfg-field__error"
                  role="alert"
                >
                  {error()}
                </span>
              </div>
            </div>
          </Show>
        </>
      )}
    </Show>
  );
}
