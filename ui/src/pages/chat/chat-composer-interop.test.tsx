/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { solidContent } from "../../lit/solid-content.tsx";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { LitContent } from "./components/chat-composer-interop.tsx";

it("mounts nested Solid content when opaque Lit content changes after mount", async () => {
  const Label = (props: { text: string }) => <b class="nested-label">{props.text}</b>;
  const initial = document.createElement("i");
  initial.textContent = "initial";
  const [value, setValue] = createSignal<unknown>(initial);
  const view = mountSolid(() => <LitContent value={value()} />);

  // Composer updates reach LitContent from its render effect, where nested
  // directives must not create roots without an owner.
  setValue(solidContent(Label, { text: "attached" }));
  flush();
  await waitForSolid(() =>
    expect(view.container.querySelector(".nested-label")?.textContent).toBe("attached"),
  );

  setValue(solidContent(Label, { text: "still reactive" }));
  await waitForSolid(() =>
    expect(view.container.querySelector(".nested-label")?.textContent).toBe("still reactive"),
  );
});
