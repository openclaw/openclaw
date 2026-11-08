// Import before a controller so its choice-prompt dependency sees this module mock.
import type { Component, SelectItem } from "@earendil-works/pi-tui";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";

export type TestChoiceSelector = Component & {
  items: SelectItem[];
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  setSelectedIndex: ReturnType<typeof vi.fn<(index: number) => void>>;
};

const selectorFixtures = vi.hoisted(() => ({
  bySelector: new WeakMap<object, TestChoiceSelector>(),
  byPrompt: new WeakMap<object, TestChoiceSelector>(),
}));

vi.mock("./choice-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./choice-prompt.js")>();
  return {
    ...actual,
    createTuiChoiceSelector: (items: SelectItem[]) => {
      const real = actual.createTuiChoiceSelector(items);
      const selectIndex = real.setSelectedIndex?.bind(real);
      const selector = Object.assign(real, {
        items,
        setSelectedIndex: vi.fn((index: number) => selectIndex?.(index)),
      });
      selectorFixtures.bySelector.set(selector, selector);
      return selector;
    },
    TuiChoicePrompt: class extends actual.TuiChoicePrompt {
      constructor(...args: ConstructorParameters<typeof actual.TuiChoicePrompt>) {
        super(...args);
        const selector = expectDefined(
          selectorFixtures.bySelector.get(args[2]),
          "prompt selector fixture",
        );
        selectorFixtures.byPrompt.set(this, selector);
      }
    },
  };
});

export function captureChoicePromptSelector(component: Component): TestChoiceSelector {
  return expectDefined(selectorFixtures.byPrompt.get(component), "owned prompt selector");
}
