/* @vitest-environment jsdom */
import { createSignal, onCleanup } from "solid-js";
import { expect, it, vi } from "vitest";
import type { SolidRouteProps } from "../app-routes.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { SolidRouteContent } from "./solid-route-content.tsx";

it("preserves the page draft through loader and visibility updates and retires it on navigation", () => {
  const firstCleanup = vi.fn();
  const secondCleanup = vi.fn();
  function FirstPage(props: SolidRouteProps) {
    const [draft, setDraft] = createSignal("");
    onCleanup(firstCleanup);
    return (
      <section>
        <input
          aria-label="Page draft"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <output>{draft()}</output>
        <p>
          {String(props.data)} / {props.loaderPending ? "loading" : "ready"} /{" "}
          {props.presented ? "visible" : "parked"}
        </p>
      </section>
    );
  }
  function SecondPage(props: SolidRouteProps) {
    onCleanup(secondCleanup);
    return <p>Replacement page: {String(props.data)}</p>;
  }
  const [route, setRoute] = createSignal<SolidRouteProps>({
    data: "Initial",
    loaderPending: true,
    presented: true,
  });
  const [second, setSecond] = createSignal(false);
  const view = mountSolid(() => (
    <SolidRouteContent {...route()} render={second() ? SecondPage : FirstPage} />
  ));
  const input = view.getByRole<HTMLInputElement>("textbox", { name: "Page draft" });
  input.focus();
  input.value = "Unsaved notes";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();

  for (const next of [
    { data: "Loaded", loaderPending: true, presented: true },
    { data: "Loaded", loaderPending: false, presented: true },
    { data: "Loaded", loaderPending: false, presented: false },
    { data: "Loaded", loaderPending: false, presented: true },
  ]) {
    setRoute(next);
    flush();
    expect(view.getByRole("textbox", { name: "Page draft" })).toBe(input);
    expect(input.value).toBe("Unsaved notes");
    expect(document.activeElement).toBe(input);
    expect(
      view.getByText(
        `${next.data} / ${next.loaderPending ? "loading" : "ready"} / ${next.presented ? "visible" : "parked"}`,
      ),
    ).toBeTruthy();
    expect(firstCleanup).not.toHaveBeenCalled();
  }

  setSecond(true);
  flush();
  expect(view.queryByRole("textbox", { name: "Page draft" })).toBeNull();
  expect(view.getByText("Replacement page: Loaded")).toBeTruthy();
  expect(firstCleanup).toHaveBeenCalledOnce();
  view.unmount();
  expect(secondCleanup).toHaveBeenCalledOnce();
});
