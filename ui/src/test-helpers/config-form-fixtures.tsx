import type { JSX } from "@solidjs/web";
import { onCleanup, type Accessor } from "solid-js";
import { expect } from "vitest";
import { analyzeConfigSchema } from "../components/config-form.analyze.ts";
import { ConfigArray, ConfigObject } from "../components/config-form.node.collection.tsx";
import { NumberInput, SelectInput, TextInput } from "../components/config-form.node.scalar.tsx";
import type { ConfigNodeRenderParams } from "../components/config-form.node.shared.ts";
import { renderNode } from "../components/config-form.node.tsx";
import { ConfigForm } from "../components/config-form.render.tsx";
import type { ConfigFormProps } from "../components/config-form.shared.ts";
import { mountSolid } from "./solid-render.tsx";
import { flush } from "./solid-settle.ts";

export const connectionSchemaFixture = (): ConfigNodeRenderParams["schema"] => ({
  type: "object",
  required: ["host", "port"],
  properties: {
    host: { type: "string", minLength: 1 },
    port: { type: "integer", minimum: 1 },
  },
});

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
      const view = mountSolid(
        (value: { props: Props }) => {
          onCleanup(() => {
            mounted.delete(container);
            activeMounts.delete(container);
          });
          return component(() => value.props);
        },
        { props },
        container,
      );
      mounted.set(container, (next) => view.update({ props: next }));
      activeMounts.set(container, view.dispose);
    }
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

export function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

export async function expandConfigObjects(container: ParentNode) {
  for (;;) {
    const details = container.querySelector<HTMLDetailsElement>("details.cfg-object:not([open])");
    if (!details) {
      return;
    }
    await new Promise<void>((resolve) => {
      details.addEventListener("toggle", () => resolve(), { once: true });
      expectElement(
        details.querySelector<HTMLElement>(":scope > summary"),
        "object summary",
      ).click();
    });
    flush();
  }
}
