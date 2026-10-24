import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { analyzeConfigSchema } from "../components/config-form.analyze.ts";
import { ConfigArray, ConfigObject } from "../components/config-form.node.collection.tsx";
import { NumberInput, SelectInput, TextInput } from "../components/config-form.node.scalar.tsx";
import type { ConfigNodeRenderParams } from "../components/config-form.node.shared.ts";
import { renderNode } from "../components/config-form.node.tsx";
import { ConfigForm } from "../components/config-form.render.tsx";
import type { ConfigFormProps } from "../components/config-form.shared.ts";
import { mountSolid } from "./mount-solid.ts";
import { flush } from "./solid-settle.ts";

type NodeDefaults = Pick<ConfigNodeRenderParams, "hints" | "unsupported" | "disabled">;
type FixtureOptions<Extra = object> = Omit<ConfigNodeRenderParams, keyof NodeDefaults> &
  Partial<NodeDefaults> &
  Extra;

function nodeOptions<Options extends FixtureOptions>(options: Options) {
  return { hints: {}, unsupported: new Set<string>(), disabled: false, ...options };
}

const activeMounts = new WeakMap<HTMLElement, () => void>();
export const disposeConfigFormFixture = (container: HTMLElement) => activeMounts.get(container)?.();
function fixture<Props>(component: (props: Accessor<Props>) => JSX.Element) {
  const mounted = new WeakMap<HTMLElement, (props: Props) => void>();
  return (container: HTMLElement, props: Props) => {
    const update = mounted.get(container);
    if (update) {
      update(props);
    } else {
      activeMounts.get(container)?.();
      const [value, setValue] = createSignal({ props });
      const view = mountSolid(
        () => {
          onCleanup(() => {
            mounted.delete(container);
            activeMounts.delete(container);
          });
          return component(() => value().props);
        },
        { container },
      );
      mounted.set(container, (next) => setValue({ props: next }));
      activeMounts.set(container, view.unmount);
    }
    flush();
  };
}

function nodeFixture<Extra = object>(
  component: (props: Accessor<ConfigNodeRenderParams & Extra>) => JSX.Element,
) {
  const render = fixture(component);
  return (container: HTMLElement, options: FixtureOptions<Extra>) =>
    render(container, nodeOptions(options));
}
export const renderNodeFixture = nodeFixture((props) => renderNode(props));
export const renderConfigFormFixture = fixture((props: Accessor<ConfigFormProps>) => (
  <ConfigForm {...props()} />
));
export const renderArrayFixture = nodeFixture((props) => (
  <ConfigArray params={props()} renderNode={renderNode} />
));
export const renderObjectFixture = nodeFixture((props) => (
  <ConfigObject params={props()} renderNode={renderNode} />
));
export const renderTextInputFixture = nodeFixture<{ inputType: "text" | "number" }>((props) => (
  <TextInput params={props()} />
));
export const renderNumberInputFixture = nodeFixture((props) => <NumberInput params={props()} />);
export const renderSelectFixture = nodeFixture<{ options: unknown[] }>((props) => (
  <SelectInput params={props()} />
));
export function renderAnalyzedFormFixture(
  container: HTMLElement,
  analysis: ReturnType<typeof analyzeConfigSchema>,
  props: Omit<ConfigFormProps, "schema" | "unsupportedPaths" | "uiHints" | "onShowAdvanced"> &
    Partial<Pick<ConfigFormProps, "uiHints" | "onShowAdvanced">>,
) {
  renderConfigFormFixture(container, {
    schema: analysis.schema,
    unsupportedPaths: analysis.unsupportedPaths,
    uiHints: {},
    showAdvanced: true,
    onShowAdvanced: () => {},
    ...props,
  });
}
