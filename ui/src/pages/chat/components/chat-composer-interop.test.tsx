import { createContext, createSignal, useContext } from "solid-js";
import { expect, it } from "vitest";
import { emptyLegacyContent } from "../../../lit/solid-content.tsx";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { LitContent } from "./chat-composer-interop.tsx";

it("keeps the composer owner when lazy content creates native children", () => {
  const Label = createContext<string>();
  function NativeLabel() {
    return <span>{useContext(Label)}</span>;
  }
  const view = mountSolid(() => (
    <Label value="Composer footer">
      <LitContent value={<NativeLabel />} />
    </Label>
  ));
  expect(view.getByText("Composer footer")).toBeTruthy();
  view.unmount();
});

it("keeps native composer content mounted while its text updates", () => {
  const [label, setLabel] = createSignal("Connecting");
  const view = mountSolid(() => <LitContent value={<div role="status">{label()}</div>} />);
  const status = view.getByRole("status");
  expect(status.textContent).toBe("Connecting");
  setLabel("Connected");
  flush();
  expect(view.getByRole("status")).toBe(status);
  expect(status.textContent).toBe("Connected");
});

it("leaves no empty host for absent composer content", () => {
  const [content, setContent] = createSignal<unknown>(undefined);
  const view = mountSolid(() => <LitContent value={content()} />);
  expect(view.container.children).toHaveLength(0);
  setContent(<p>Available notice</p>);
  flush();
  expect(view.getByText("Available notice")).toBeTruthy();
  setContent(emptyLegacyContent);
  flush();
  expect(view.container.children).toHaveLength(0);
});
