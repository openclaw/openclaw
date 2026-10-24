/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { buildSkillLibraryMock } from "../../test-helpers/skill-library-fixtures.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  ChatComposerCapabilityDialogs,
  type ChatComposerCapabilityDialogsProps,
} from "./chat-composer-capability-host.tsx";

const imports = vi.hoisted(() => ({ server: 0, library: 0 }));

// mock-isolation: observe module evaluation while exercising the real dialog renderers.
vi.mock("./components/chat-composer-add-server-dialog.tsx", async (importOriginal) => {
  imports.server += 1;
  return importOriginal<typeof import("./components/chat-composer-add-server-dialog.tsx")>();
});
vi.mock("../skills/library-detail.tsx", async (importOriginal) => {
  imports.library += 1;
  return importOriginal<typeof import("../skills/library-detail.tsx")>();
});

it("loads capability dialogs only when opened and retains their live native controls", async () => {
  expect(imports).toEqual({ server: 0, library: 0 });
  const initial: ReturnType<ChatComposerCapabilityDialogsProps["read"]> = {
    open: false,
    busy: false,
    scope: "session",
    error: null,
    scopeBlockedReason: null,
    submitBlockedReason: null,
    onCancel: vi.fn(),
    onScopeChange: vi.fn(),
    onSubmit: vi.fn(),
    library: null,
  };
  const [state, setState] = createSignal(initial);
  const view = mountSolid(() => <ChatComposerCapabilityDialogs read={state} />);
  expect(imports).toEqual({ server: 0, library: 0 });

  setState({ ...initial, open: true });
  await waitForSolid(() => expect(view.container.querySelector("form")).not.toBeNull());
  expect(imports).toEqual({ server: 1, library: 0 });
  const form = view.container.querySelector("form");
  const name = view.container.querySelector<HTMLInputElement>('[name="mcp-name"]')!;
  name.value = "draft-server";
  setState({ ...initial, open: true, scope: "everywhere", error: "Try another name" });
  await waitForSolid(() => expect(view.container.textContent).toContain("Try another name"));
  expect(view.container.querySelector("form")).toBe(form);
  expect(name.value).toBe("draft-server");
  setState(initial);
  flush();
  expect(view.container.querySelector("form")).toBeNull();

  const [read] = buildSkillLibraryMock();
  const library = { read, file: "SKILL.md", onFile: vi.fn(), onClose: vi.fn() };
  setState({ ...initial, library });
  await waitForSolid(() =>
    expect(view.container.querySelector("textarea")?.value).toBe(read.content),
  );
  expect(imports).toEqual({ server: 1, library: 1 });
  const modal = view.container.querySelector("openclaw-modal-dialog");
  const select = view.container.querySelector("select");
  const details = view.container.querySelector("details")!;
  details.open = true;
  const file = expectDefined(read.files[0], "library fixture file");
  setState({ ...initial, library: { ...library, file: file.path } });
  await waitForSolid(() =>
    expect(view.container.querySelector("textarea")?.value).toBe(
      file.content.replaceAll("\r\n", "\n"),
    ),
  );
  expect(view.container.querySelector("openclaw-modal-dialog")).toBe(modal);
  expect(view.container.querySelector("select")).toBe(select);
  expect(view.container.querySelector("details")).toBe(details);
  expect(details.open).toBe(true);
  view.container.querySelector<HTMLButtonElement>(".exec-approval-header button")!.click();
  expect(library.onClose).toHaveBeenCalledOnce();
});
