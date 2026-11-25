// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { RetryAction } from "./settings-ui.tsx";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

it("retains its native button and dispatches the current retry after props change", () => {
  const first = vi.fn();
  const second = vi.fn();
  const view = mountSolid<Parameters<typeof RetryAction>[0]>(RetryAction, {
    onRetry: first,
    disabled: true,
    label: "Retry",
  });
  cleanup = () => {
    view.dispose();
    view.container.remove();
  };
  const button = view.container.querySelector("button")!;
  expect(button.className).toBe("btn btn--sm");
  expect(button.hasAttribute("type")).toBe(false);
  button.click();
  expect(first).not.toHaveBeenCalled();

  view.update({
    onRetry: second,
    disabled: false,
    label: "Try again",
    class: "btn btn--sm oc-action oc-action-secondary",
    type: "button",
  });
  expect(view.container.querySelector("button")).toBe(button);
  expect(button.textContent).toBe("Try again");
  expect(button.className).toBe("btn btn--sm oc-action oc-action-secondary");
  expect(button.getAttribute("type")).toBe("button");
  button.click();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
});
