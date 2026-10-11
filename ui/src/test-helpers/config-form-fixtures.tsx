import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { analyzeConfigSchema } from "../components/config-form.analyze.ts";
import { ConfigArray, ConfigObject } from "../components/config-form.node.collection.tsx";
import { JsonTextarea } from "../components/config-form.node.json.tsx";
import { NumberInput, SelectInput, TextInput } from "../components/config-form.node.scalar.tsx";
import type { ConfigNodeRenderParams } from "../components/config-form.node.shared.ts";
import { renderNode } from "../components/config-form.node.tsx";
import { ConfigForm } from "../components/config-form.render.tsx";
import type { ConfigFormProps } from "../components/config-form.shared.ts";
import { mountSolid } from "./mount-solid.ts";
import { flush } from "./solid-settle.ts";

type FixtureOptions<Extra = object> = Omit<
  ConfigNodeRenderParams,
  "hints" | "unsupported" | "disabled"
> &
  Partial<Pick<ConfigNodeRenderParams, "hints" | "unsupported" | "disabled">> &
  Extra;

function nodeOptions<Options extends FixtureOptions>(options: Options) {
  return { hints: {}, unsupported: new Set<string>(), disabled: false, ...options };
}

const activeMounts = new WeakMap<HTMLElement, () => void>();
export function disposeConfigFormFixture(container: HTMLElement) {
  activeMounts.get(container)?.();
}
function fixture<Props>(component: (props: Accessor<Props>) => JSX.Element) {
  const mounted = new WeakMap<HTMLElement, (props: Props) => void>();
  return (container: HTMLElement, props: Props) => {
    const update = mounted.get(container);
    if (update) {
      update(props);
    } else {
      activeMounts.get(container)?.();
      const [value, setValue] = createSignal(props);
      const view = mountSolid(
        () => {
          onCleanup(() => {
            mounted.delete(container);
            activeMounts.delete(container);
          });
          return component(value);
        },
        { container },
      );
      mounted.set(container, (next) => setValue(() => next));
      activeMounts.set(container, view.unmount);
    }
    flush();
  };
}

const array = fixture((props: Accessor<ConfigNodeRenderParams>) => (
  <ConfigArray params={props()} renderNode={renderNode} />
));
const object = fixture((props: Accessor<ConfigNodeRenderParams>) => (
  <ConfigObject params={props()} renderNode={renderNode} />
));
const json = fixture((props: Accessor<ConfigNodeRenderParams>) => (
  <JsonTextarea params={props()} />
));
const text = fixture(
  (props: Accessor<ConfigNodeRenderParams & { inputType: "text" | "number" }>) => (
    <TextInput params={props()} />
  ),
);
const number = fixture((props: Accessor<ConfigNodeRenderParams>) => (
  <NumberInput params={props()} />
));
const select = fixture((props: Accessor<ConfigNodeRenderParams & { options: unknown[] }>) => (
  <SelectInput params={props()} />
));
const form = fixture((props: Accessor<ConfigFormProps>) => <ConfigForm {...props()} />);
const node = fixture((props: Accessor<ConfigNodeRenderParams>) => renderNode(props));
export function renderNodeFixture(container: HTMLElement, options: FixtureOptions) {
  node(container, nodeOptions(options));
}
export function renderConfigFormFixture(container: HTMLElement, props: ConfigFormProps) {
  form(container, props);
}

export function renderArrayFixture(container: HTMLElement, options: FixtureOptions) {
  array(container, nodeOptions(options));
}
export function renderObjectFixture(container: HTMLElement, options: FixtureOptions) {
  object(container, nodeOptions(options));
}
export function renderJsonTextareaFixture(container: HTMLElement, options: FixtureOptions) {
  json(container, nodeOptions(options));
}
export function renderTextInputFixture(
  container: HTMLElement,
  options: FixtureOptions<{ inputType: "text" | "number" }>,
) {
  text(container, nodeOptions(options));
}
export function renderNumberInputFixture(container: HTMLElement, options: FixtureOptions) {
  number(container, nodeOptions(options));
}
export function renderSelectFixture(
  container: HTMLElement,
  options: FixtureOptions<{ options: unknown[] }>,
) {
  select(container, nodeOptions(options));
}
export function renderAnalyzedFormFixture(
  container: HTMLElement,
  analysis: ReturnType<typeof analyzeConfigSchema>,
  props: Omit<ConfigFormProps, "schema" | "unsupportedPaths" | "uiHints" | "onShowAdvanced"> &
    Partial<Pick<ConfigFormProps, "uiHints" | "onShowAdvanced">>,
) {
  form(container, {
    schema: analysis.schema,
    unsupportedPaths: analysis.unsupportedPaths,
    uiHints: {},
    showAdvanced: true,
    onShowAdvanced: () => {},
    ...props,
  });
}
