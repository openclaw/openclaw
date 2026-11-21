import type { JSX } from "@solidjs/web";
import { createContext, createSignal, useContext } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ComposerContent } from "./chat-composer-content.tsx";

it("keeps the composer owner when lazy content creates native children", () => {
  const Label = createContext<string>();
  function NativeLabel() {
    return <span>{useContext(Label)}</span>;
  }
  const view = mountSolid(() => (
    <Label value="Composer footer">
      <ComposerContent>
        <NativeLabel />
      </ComposerContent>
    </Label>
  ));
  expect(view.getByText("Composer footer")).toBeTruthy();
  view.unmount();
});

it("keeps native composer content mounted while its text updates", () => {
  const [label, setLabel] = createSignal("Connecting");
  const view = mountSolid(() => (
    <ComposerContent>
      <div role="status">{label()}</div>
    </ComposerContent>
  ));
  const status = view.getByRole("status");
  expect(status.textContent).toBe("Connecting");
  setLabel("Connected");
  flush();
  expect(view.getByRole("status")).toBe(status);
  expect(status.textContent).toBe("Connected");
});

it("leaves no empty host for absent composer content", () => {
  const [content, setContent] = createSignal<JSX.Element>(undefined);
  const view = mountSolid(() => <ComposerContent>{content()}</ComposerContent>);
  expect(view.container.children).toHaveLength(0);
  setContent(<p>Available notice</p>);
  flush();
  expect(view.getByText("Available notice")).toBeTruthy();
  setContent(null);
  flush();
  expect(view.container.children).toHaveLength(0);
});
