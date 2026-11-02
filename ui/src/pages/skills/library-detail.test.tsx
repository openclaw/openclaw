/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { SkillsLibraryReadResult } from "../../../../packages/gateway-protocol/src/schema/skill-library.ts";
import { registerSkillLibraryEnglish } from "../../i18n/locales/en-skill-library.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { LibraryPinRead } from "./library-detail.tsx";

registerEnglishCatalog(registerSkillLibraryEnglish);

it("keeps a session pin read-only while switching its text and binary files", () => {
  const read: SkillsLibraryReadResult = {
    entry: {
      skillId: "12345678-1234-1234-1234-123456789abc",
      revision: "a".repeat(64),
      slug: "session-skill",
      name: "session-skill",
      description: "A synthetic pinned skill",
      ownerProfileId: "alice",
      authorProfileId: "alice",
      ownerLabel: "Alice",
      shared: false,
      enabled: true,
      removed: false,
      canEdit: true,
      createdAt: 1,
      updatedAt: 1,
    },
    content: "# Pinned skill",
    files: [
      { path: "notes.txt", content: "Pinned notes", encoding: "utf8", executable: false },
      { path: "image.png", content: "iVBORw0KGgo=", encoding: "base64", executable: false },
    ],
    revisions: [{ revision: "a".repeat(64), createdAt: 1 }],
  };
  const container = document.body.appendChild(document.createElement("div"));
  const close = vi.fn();
  const [file, setFile] = createSignal("SKILL.md");
  const view = mountSolid(
    () => <LibraryPinRead read={read} file={file()} onFile={setFile} onClose={close} />,
    { container },
  );
  try {
    flush();
    const select = container.querySelector("select")!;
    const text = container.querySelector("textarea")!;
    expect(text.readOnly).toBe(true);
    expect(text.value).toBe("# Pinned skill");
    select.focus();
    select.value = "notes.txt";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    expect(container.querySelector("select")).toBe(select);
    expect(document.activeElement).toBe(select);
    expect(container.querySelector("textarea")?.value).toBe("Pinned notes");
    select.value = "image.png";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Binary attachment retained with this revision.");
    container.querySelector<HTMLButtonElement>(".exec-approval-header button")!.click();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    container.remove();
  }
});
