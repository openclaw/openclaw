import type {
  CustomEndpointModel,
  CustomEndpointModelEdits,
} from "../../../../src/shared/custom-endpoint.js";
import { t } from "../../lib/reactive/i18n.ts";

export function EndpointModel(props: {
  model: CustomEndpointModel;
  number: number;
  provider: string;
  route: string;
  disabled: boolean;
  canRemove: boolean;
  onEdit: (edits: CustomEndpointModelEdits) => void;
  onIdChange: (id: string) => void;
  onRemove: () => void;
}) {
  return (
    <fieldset class="custom-endpoint-editor__model" disabled={props.disabled}>
      <legend>{t("modelProviders.endpoints.modelRow", { number: String(props.number) })}</legend>
      <div class="custom-endpoint-editor__connection">
        <label class="field">
          <span>{t("modelProviders.endpoints.modelId")}</span>
          <input
            required
            value={props.model.id}
            onInput={(event) => props.onIdChange(event.currentTarget.value)}
          />
        </label>
        <label class="field">
          <span>{t("modelProviders.endpoints.modelName")}</span>
          <input
            required
            value={props.model.name}
            onInput={(event) => props.onEdit({ name: event.currentTarget.value })}
          />
        </label>
        <label class="field">
          <span>{t("modelProviders.endpoints.context")}</span>
          <input
            type="number"
            min="1"
            value={props.model.contextWindow ?? ""}
            placeholder={t("modelProviders.endpoints.unspecified")}
            onInput={(event) =>
              props.onEdit({
                contextWindow:
                  event.currentTarget.value === "" ? null : Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label class="field">
          <span>{t("modelProviders.endpoints.output")}</span>
          <input
            type="number"
            min="1"
            value={props.model.maxTokens ?? ""}
            placeholder={t("modelProviders.endpoints.unspecified")}
            onInput={(event) =>
              props.onEdit({
                maxTokens:
                  event.currentTarget.value === "" ? null : Number(event.currentTarget.value),
              })
            }
          />
        </label>
      </div>
      <label>
        <input
          type="checkbox"
          checked={props.model.input?.includes("text") ?? false}
          prop:indeterminate={props.model.input === undefined}
          onChange={(event) => props.onEdit({ textInput: event.currentTarget.checked })}
        />{" "}
        {t("modelProviders.endpoints.text")}
      </label>{" "}
      <label>
        <input
          type="checkbox"
          checked={props.model.input?.includes("image") ?? false}
          prop:indeterminate={props.model.input === undefined}
          onChange={(event) => props.onEdit({ imageInput: event.currentTarget.checked })}
        />{" "}
        {t("modelProviders.endpoints.image")}
      </label>{" "}
      <label>
        <input
          type="checkbox"
          checked={props.model.reasoning ?? false}
          prop:indeterminate={props.model.reasoning === undefined}
          onChange={(event) => props.onEdit({ reasoning: event.currentTarget.checked })}
        />{" "}
        {t("modelProviders.endpoints.reasoning")}
      </label>
      <p class="muted">
        {props.provider}/{props.model.id}
        <br />
        {props.route}
      </p>
      <button
        type="button"
        class="btn btn--sm"
        disabled={!props.canRemove}
        onClick={() => props.onRemove()}
      >
        {t("modelProviders.endpoints.removeModel")}
      </button>
    </fieldset>
  );
}
