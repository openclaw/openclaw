/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { PersonalInstructions } from "./personal-instructions.tsx";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";
import { disconnectedGitHub, mockRpc } from "./profile-rpc.test-support.ts";

const file = {
  agentId: "main",
  profileId: "profile-1",
  content: "Keep it concise.",
  hash: "hash-1",
  missing: false,
};
const hello = {
  type: "hello-ok",
  protocol: 3,
  server: { connId: "connection-1" },
  snapshot: {},
  policy: { hasMultipleSessionSharingIdentities: true },
  auth: { role: "operator", scopes: ["operator.read"] },
} satisfies NonNullable<ApplicationGatewaySnapshot["hello"]>;
beforeEach(() => i18n.setLocale("en"));
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function createContext(
  request: GatewayBrowserClient["request"],
  signedIn = true,
  multipleProfiles = true,
) {
  const harness = createConnectedContext(
    request,
    signedIn ? { id: "profile-1", name: "Ada" } : null,
  );
  const base = harness.context;
  harness.emitHello({
    ...hello,
    policy: { hasMultipleSessionSharingIdentities: multipleProfiles },
  });
  const agents = base.agents;
  agents.state.agentsList = makeBootRoster({
    agents: ["main", "other"].map((id) => ({ id })),
  });
  const selection = base.settingsAgentSelection;
  selection.set("main");
  return {
    context: base,
    selection,
    emit: (patch: Parameters<typeof harness.emitSnapshot>[0]) => harness.emitSnapshot(patch),
  };
}
function mount(request: GatewayBrowserClient["request"], signedIn = true, multipleProfiles = true) {
  const harness = createContext(request, signedIn, multipleProfiles);
  const provider = createSolidApplicationContextProvider(harness.context);
  const { container: element } = mountSolid(() => <PersonalInstructions />, {
    wrapper: provider.wrapper,
  });
  return { ...harness, element };
}
type PersonalFile = Omit<typeof file, "hash"> & { hash: string | null };
function replies(...results: (Partial<PersonalFile> | Promise<PersonalFile> | Error)[]) {
  const request = vi.fn();
  for (const result of results) {
    if (result instanceof Error) {
      request.mockRejectedValueOnce(result);
    } else if (result instanceof Promise) {
      request.mockReturnValueOnce(result);
    } else {
      request.mockResolvedValueOnce({ ...file, ...result });
    }
  }
  return request;
}
async function loaded(request = replies({})) {
  const harness = mount(request);
  await idle(harness.element);
  return { ...harness, request };
}
function clientFile(result: Partial<PersonalFile>) {
  return createTestGatewayClient(vi.fn().mockResolvedValue({ ...file, ...result }));
}
async function save(element: HTMLElement, content: string) {
  await input(element, content);
  button(element, "Save").click();
  await idle(element);
}
function idle(element: HTMLElement) {
  return waitForSolid(() => expect(element.querySelector('[aria-busy="true"]')).toBeNull());
}
function button(element: HTMLElement, text: string) {
  return [...element.querySelectorAll("button")].find((el) => el.textContent?.trim() === text)!;
}
async function input(element: HTMLElement, value: string) {
  const editor = element.querySelector("textarea")!;
  editor.value = value;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

it("creates the signed-in personal file", async () => {
  const initial = { ...file, content: "", hash: null, missing: true };
  const content = "New file";
  const request = replies(initial, { content, hash: "hash-2" });
  const { element } = await loaded(request);
  expect(request).toHaveBeenCalledWith("users.personalFile.get", { agentId: "main" });
  expect(button(element, "Save").disabled).toBe(true);
  expect(button(element, "Reload")).toBeUndefined();
  const heading = element.querySelector(".settings-section__heading");
  const editor = element.querySelector("textarea");
  expect(heading?.textContent?.trim()).toBe("Personal instructions");
  expect(element.querySelectorAll(".settings-section__heading")).toHaveLength(1);
  expect(element.querySelector(".personal-instructions label")).toBeNull();
  expect(editor?.getAttribute("aria-label")).toBe("Personal instructions");
  expect(editor?.getAttribute("aria-describedby")).toBe("personal-instructions-guidance");
  expect(editor?.rows).toBe(7);
  expect(element.textContent).toContain("created when you save");
  await input(element, "x".repeat(4001));
  expect(button(element, "Save").disabled).toBe(true);
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("4,000");
  await save(element, content);
  expect(request).toHaveBeenLastCalledWith("users.personalFile.set", {
    agentId: "main",
    content,
    expectedHash: initial.hash,
  });
  expect(element.textContent).toContain("Saved");
  expect(button(element, "Reload")).toBeUndefined();
});

it.each([
  [false, true],
  [true, false],
])(
  "never loads personal files with sign-in=%s and multiple profiles=%s",
  async (signedIn, multipleProfiles) => {
    const request = signedIn ? vi.fn().mockResolvedValue(file) : vi.fn();
    const { element } = mount(request, signedIn, multipleProfiles);
    await idle(element);
    expect(request).not.toHaveBeenCalled();
    expect(element.querySelector("textarea")).toBeNull();
    if (!multipleProfiles) {
      expect(element.textContent?.trim()).toBe("");
    }
  },
);

it("preserves a conflicting draft, confirms reload, and keeps it when reload fails", async () => {
  const request = replies(
    {},
    new Error("Personal USER.md changed since read"),
    new Error("Offline"),
    { content: "External edit", hash: "hash-new" },
  );
  const { element } = await loaded(request);
  await save(element, "My draft");
  expect(element.querySelector("textarea")?.value).toBe("My draft");
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("changed since read");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  button(element, "Reload").click();
  await idle(element);
  expect(request).toHaveBeenCalledTimes(2);
  confirm.mockReturnValue(true);
  button(element, "Reload").click();
  await idle(element);
  expect(element.querySelector("textarea")?.value).toBe("My draft");
  button(element, "Reload").click();
  await idle(element);
  expect(element.querySelector("textarea")?.value).toBe("External edit");
  expect(button(element, "Reload")).toBeUndefined();
});

it("never restores a former person's cached draft after an account change", async () => {
  const request = replies({}, { agentId: "other", content: "Other agent" });
  const { element, selection, emit } = await loaded(request);
  await input(element, "Former person's draft");
  selection.set("other");
  await idle(element);
  emit({
    selfUser: { id: "profile-2" },
    client: clientFile({ profileId: "profile-2", agentId: "other", content: "New person" }),
  });
  await idle(element);
  selection.set("main");
  await idle(element);
  expect(element.querySelector("textarea")?.value).not.toBe("Former person's draft");
});

it.each([
  ["agent", "other", "profile-1", false],
  ["profile", "main", "profile-2", false],
  ["connection hello", "main", "profile-1", false],
  ["connection hello", "main", "profile-1", true],
] as const)(
  "retires the old read after %s targeting %s/%s (replacement pending: %s)",
  async (change, agentId, profileId, pending) => {
    const old = createDeferred<PersonalFile>();
    const replacement = createDeferred<PersonalFile>();
    const current = { ...file, agentId, profileId, content: "Current instructions" };
    const request =
      change === "profile"
        ? vi.fn().mockReturnValue(old.promise)
        : vi
            .fn()
            .mockReturnValueOnce(old.promise)
            .mockReturnValueOnce(pending ? replacement.promise : Promise.resolve(current));
    const { element, selection, emit } = mount(request);
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledWith("users.personalFile.get", { agentId: "main" });
      expect(element.querySelector('[aria-busy="true"]')).not.toBeNull();
    });
    if (change === "agent") {
      selection.set("other");
    } else if (change === "profile") {
      emit({ client: clientFile(current), selfUser: { id: "profile-2" } });
    } else {
      emit({ hello: { ...hello, server: { connId: "connection-2" } } });
    }
    if (pending) {
      await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    } else {
      await idle(element);
    }
    old.resolve(file);
    await old.promise;
    if (pending) {
      flush();
      expect(element.querySelector("textarea")).toBeNull();
      expect(button(element, "Save").disabled).toBe(true);
      replacement.resolve(current);
    }
    await idle(element);
    expect(element.querySelector("textarea")?.value).toBe(current.content);
    if (pending) {
      await input(element, "New draft");
      expect(element.querySelector("textarea")).toMatchObject({ value: "New draft" });
      expect(button(element, "Save").disabled).toBe(false);
    }
  },
);

it("retains the unsettled draft but ignores an old save completion after reconnecting", async () => {
  const saving = createDeferred<typeof file>();
  const request = replies({}, saving.promise);
  const { element, emit } = await loaded(request);
  await input(element, "Old draft");
  const submit = button(element, "Save");
  submit.click();
  submit.click();
  expect(request).toHaveBeenCalledTimes(2);
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledWith("users.personalFile.set", {
      agentId: "main",
      content: "Old draft",
      expectedHash: file.hash,
    });
    expect(element.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(button(element, "Saving…")).toMatchObject({ disabled: true });
  });
  expect(
    element.querySelector<HTMLButtonElement>(".personal-instructions__actions button")?.disabled,
  ).toBe(true);
  emit({
    client: clientFile({ content: "Current connection" }),
  });
  await idle(element);
  saving.resolve({ ...file, content: "Old draft" });
  await saving.promise;
  await idle(element);
  expect(element.querySelector("textarea")?.value).toBe("Old draft");
  expect(element.textContent).toContain("Unsaved changes");
});

it("preserves newer draft edits after returning to an agent with a pending save", async () => {
  const saving = createDeferred<typeof file>();
  const request = replies(
    {},
    saving.promise,
    { agentId: "other", content: "Other instructions" },
    { hash: "hash-3" },
  );
  const { element, selection } = mount(request);
  await waitForSolid(() => expect(element.querySelector("textarea")?.value).toBe(file.content));
  await input(element, "First edit");
  button(element, "Save").click();
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(element.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(button(element, "Saving…")).toMatchObject({ disabled: true });
  });
  selection.set("other");
  await waitForSolid(() =>
    expect(element.querySelector("textarea")?.value).toBe("Other instructions"),
  );
  selection.set("main");
  await waitForSolid(() => expect(element.querySelector("textarea")?.value).toBe("First edit"));
  await input(element, "Second edit");

  saving.resolve({ ...file, content: "First edit", hash: "hash-2" });
  await saving.promise;
  flush();
  expect(element.querySelector("textarea")?.value).toBe("Second edit");
  expect(element.textContent).toContain("Unsaved changes");
  expect(button(element, "Save").disabled).toBe(false);

  await input(element, file.content);
  expect(button(element, "Save").disabled).toBe(false);
  button(element, "Save").click();
  expect(request).toHaveBeenLastCalledWith("users.personalFile.set", {
    agentId: "main",
    content: file.content,
    expectedHash: "hash-2",
  });
  await waitForSolid(() => expect(element.textContent).toContain("Saved"));
});

it("shows a pending save failure after returning to its agent without losing newer edits", async () => {
  const saving = createDeferred<typeof file>();
  const request = replies(
    {},
    saving.promise,
    { agentId: "other", content: "Other instructions" },
    { content: "Second edit", hash: "hash-2" },
  );
  const { element, selection } = await loaded(request);
  await input(element, "First edit");
  button(element, "Save").click();
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(element.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(button(element, "Saving…")).toMatchObject({ disabled: true });
  });
  selection.set("other");
  await waitForSolid(() =>
    expect(element.querySelector("textarea")?.value).toBe("Other instructions"),
  );
  selection.set("main");
  await waitForSolid(() => expect(element.querySelector("textarea")?.value).toBe("First edit"));
  await input(element, "Second edit");

  saving.reject(new Error("Save rejected after returning"));
  await waitForSolid(() =>
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("Save rejected"),
  );
  expect(element.querySelector("textarea")?.value).toBe("Second edit");
  expect(element.textContent).toContain("Unsaved changes");
  button(element, "Save").click();
  expect(request).toHaveBeenLastCalledWith("users.personalFile.set", {
    agentId: "main",
    content: "Second edit",
    expectedHash: file.hash,
  });
  await waitForSolid(() => expect(element.textContent).toContain("Saved"));
});

it("rejects a response for a different profile rather than enabling a save", async () => {
  const request = vi.fn().mockResolvedValue({ ...file, profileId: "someone-else" });
  const { element } = await loaded(request);
  expect(element.querySelector("textarea")).toBeNull();
  expect(button(element, "Save").disabled).toBe(true);
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("does not match");
});

it("clears a prior profile read error while the replacement read is pending", async () => {
  const { element, emit } = await loaded(replies(new Error("Previous profile read failed")));
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("Previous profile");
  const replacement = createDeferred<PersonalFile>();
  emit({
    selfUser: { id: "profile-2" },
    client: createTestGatewayClient(vi.fn().mockReturnValue(replacement.promise)),
  });
  await waitForSolid(() => {
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
  replacement.resolve({ ...file, profileId: "profile-2", content: "Current profile instructions" });
  await idle(element);
  expect(element.querySelector("textarea")?.value).toBe("Current profile instructions");
});

it("retires a pending read after read access is revoked", async () => {
  const old = createDeferred<typeof file>();
  const request = vi.fn().mockReturnValue(old.promise);
  const { element, emit } = mount(request);
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledWith("users.personalFile.get", { agentId: "main" });
    expect(element.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
  emit({
    hello: {
      ...hello,
      auth: { role: "operator", scopes: [] },
    },
  });
  old.resolve(file);
  await old.promise;
  await idle(element);
  expect(element.querySelector("textarea")).toBeNull();
});

it("retains drafts privately while offline and restores them only for the same profile", async () => {
  const request = vi.fn().mockResolvedValue(file);
  const { element, emit } = await loaded(request);
  await input(element, "Keep my unsaved instructions");
  emit({ phase: "offline", selfUser: null });
  await idle(element);
  expect(element.querySelector("textarea")).toBeNull();
  emit({ phase: "connected", selfUser: null });
  await idle(element);
  expect(element.querySelector("textarea")).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  emit({ phase: "connected", selfUser: { id: "profile-1" } });
  await idle(element);
  expect(element.querySelector("textarea")?.value).toBe("Keep my unsaved instructions");
  expect(request).toHaveBeenCalledTimes(1);
  emit({ phase: "offline", selfUser: null });
  emit({ phase: "connected", selfUser: null });
  await idle(element);
  expect(element.querySelector("textarea")).toBeNull();
  const otherRequest = vi
    .fn()
    .mockResolvedValue({ ...file, profileId: "profile-2", content: "Other person" });
  emit({ client: createTestGatewayClient(otherRequest), selfUser: { id: "profile-2" } });
  await idle(element);
  expect(element.querySelector("textarea")?.value).toBe("Other person");
});

it("keeps the actual Profile editor mounted across an offline transition", async () => {
  const request = mockRpc({
    "users.self": () => ({ profile: modelAccountProfile }),
    "users.personalFile.get": () => file,
    "users.listModelAccounts": () => ({
      profileId: modelAccountProfile.id,
      accounts: [],
      links: [],
    }),
    "users.github.status": () => disconnectedGitHub,
  });
  const client = createTestGatewayClient(request);
  const { context, emit } = createContext(client.request.bind(client));
  const page = mountProfilePage(context);
  flush();
  const editor = page.querySelector<HTMLElement>("openclaw-personal-instructions")!;
  await idle(editor);
  await input(editor, "Keep this draft across a network interruption");
  emit({ phase: "reconnecting" });
  flush();
  expect(page.querySelector("openclaw-personal-instructions")).toBe(editor);
  emit({ phase: "connected" });
  flush();
  await idle(editor);
  expect(editor.querySelector("textarea")?.value).toBe(
    "Keep this draft across a network interruption",
  );
});
