import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderComposerMenuOption } from "./composer-menu.ts";

describe("composer-menu stationary hover", () => {
  let container: HTMLElement;

  const renderOption = (hover: () => void) => {
    render(
      renderComposerMenuOption({
        id: "hover-test-option",
        active: false,
        select: () => undefined,
        hover,
        icon: "",
        name: "option",
        description: "option",
      }),
      container,
    );
    return container.querySelector<HTMLElement>("#hover-test-option")!;
  };

  const enterAt = (option: HTMLElement, x: number, y: number) => {
    option.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
  };

  it("accepts the first hover and ignores repeats at identical coordinates", () => {
    container = document.createElement("div");
    container.className = "slash-menu";
    document.body.append(container);
    const hover = vi.fn();
    const option = renderOption(hover);

    enterAt(option, 100, 200);
    expect(hover).toHaveBeenCalledTimes(1);

    enterAt(option, 100, 200);
    expect(hover).toHaveBeenCalledTimes(1);
  });

  it("accepts hover again after the pointer moves", () => {
    container = document.createElement("div");
    container.className = "slash-menu";
    document.body.append(container);
    const hover = vi.fn();
    const option = renderOption(hover);

    enterAt(option, 100, 200);
    enterAt(option, 100, 200);
    enterAt(option, 120, 200);
    expect(hover).toHaveBeenCalledTimes(2);
  });

  it("tracks hover coordinates independently per menu", () => {
    const first = document.createElement("div");
    first.className = "slash-menu";
    const second = document.createElement("div");
    second.className = "slash-menu";
    document.body.append(first, second);
    const firstHover = vi.fn();
    const secondHover = vi.fn();
    container = first;
    const firstOption = renderOption(firstHover);
    container = second;
    const secondOption = renderOption(secondHover);

    enterAt(firstOption, 50, 60);
    enterAt(secondOption, 50, 60);
    expect(firstHover).toHaveBeenCalledTimes(1);
    expect(secondHover).toHaveBeenCalledTimes(1);
  });

  it("fails open outside a menu root", () => {
    container = document.createElement("div");
    document.body.append(container);
    const hover = vi.fn();
    const option = renderOption(hover);

    enterAt(option, 10, 20);
    enterAt(option, 10, 20);
    expect(hover).toHaveBeenCalledTimes(2);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });
});
