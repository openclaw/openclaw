import { render } from "lit";
import { renderArray, renderObject } from "../components/config-form.node.collection.ts";
import { renderJsonTextarea } from "../components/config-form.node.json.ts";
import {
  renderNumberInput,
  renderSelect,
  renderTextInput,
} from "../components/config-form.node.scalar.ts";
import type { ConfigNodeRenderParams } from "../components/config-form.node.shared.ts";
import { analyzeConfigSchema, renderConfigForm, renderNode } from "../components/config-form.ts";

type FixtureOptions<Extra = object> = Omit<
  ConfigNodeRenderParams,
  "hints" | "unsupported" | "disabled"
> &
  Partial<Pick<ConfigNodeRenderParams, "hints" | "unsupported" | "disabled">> &
  Extra;

function nodeOptions<Options extends FixtureOptions>(options: Options) {
  return { hints: {}, unsupported: new Set<string>(), disabled: false, ...options };
}

export function renderArrayFixture(container: HTMLElement, options: FixtureOptions) {
  return render(renderArray(nodeOptions(options), renderNode), container);
}

export function renderObjectFixture(container: HTMLElement, options: FixtureOptions) {
  return render(renderObject(nodeOptions(options), renderNode), container);
}

export function renderJsonTextareaFixture(container: HTMLElement, options: FixtureOptions) {
  return render(renderJsonTextarea(nodeOptions(options)), container);
}

export function renderTextInputFixture(
  container: HTMLElement,
  options: FixtureOptions<{ inputType: "text" | "number" }>,
) {
  return render(renderTextInput(nodeOptions(options)), container);
}

export function renderNumberInputFixture(container: HTMLElement, options: FixtureOptions) {
  return render(renderNumberInput(nodeOptions(options)), container);
}

export function renderSelectFixture(
  container: HTMLElement,
  options: FixtureOptions<Pick<Parameters<typeof renderSelect>[0], "options">>,
) {
  return render(renderSelect(nodeOptions(options)), container);
}

type FormProps = Parameters<typeof renderConfigForm>[0];

export function renderAnalyzedFormFixture(
  container: HTMLElement,
  analysis: ReturnType<typeof analyzeConfigSchema>,
  props: Omit<FormProps, "schema" | "unsupportedPaths" | "uiHints" | "onShowAdvanced"> &
    Partial<Pick<FormProps, "uiHints" | "onShowAdvanced">>,
) {
  return render(
    renderConfigForm({
      schema: analysis.schema,
      unsupportedPaths: analysis.unsupportedPaths,
      uiHints: {},
      showAdvanced: true,
      onShowAdvanced: () => {},
      ...props,
    }),
    container,
  );
}
