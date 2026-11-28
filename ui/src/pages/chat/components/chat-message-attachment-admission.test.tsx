/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createChatAttachmentAdmission } from "./chat-message-attachment-admission-solid.tsx";

it("keeps an admitted attachment ready across equivalent row updates", () => {
  const [source, setSource] = createSignal({ url: "media://inbound/comment.txt" });
  const view = mountSolid(() => {
    const admission = createChatAttachmentAdmission(
      () => source().url,
      () => source().url.startsWith("data:"),
    );
    return (
      <>
        <button onClick={admission.onAdmit}>Read attachment</button>
        <output>{admission.admitted ? "Ready" : "Waiting for admission"}</output>
      </>
    );
  });
  flush();
  expect(view.getByRole("status").textContent).toBe("Waiting for admission");
  view.getByRole("button", { name: "Read attachment" }).click();
  flush();
  expect(view.getByRole("status").textContent).toBe("Ready");

  setSource({ url: "media://inbound/comment.txt" });
  flush();
  expect(view.getByRole("status").textContent).toBe("Ready");

  setSource({ url: "media://inbound/another-comment.txt" });
  flush();
  expect(view.getByRole("status").textContent).toBe("Waiting for admission");
});
