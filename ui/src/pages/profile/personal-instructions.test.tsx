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
import { createConnectedContext } from "./profile-page.test-support.tsx";

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
  vi.restoreAllMocks();
});

function mount(
  request: GatewayBrowserClient["request"],
  signedIn = true,
  multipleProfiles = true,
  scopes: string[] = hello.auth.scopes,
) {
  const harness = createConnectedContext(
    request,
    signedIn ? { id: "profile-1", name: "Ada" } : null,
  );
  const { context } = harness;
  harness.emitHello({
    ...hello,
    auth: { ...hello.auth, scopes },
    policy: { hasMultipleSessionSharingIdentities: multipleProfiles },
  });
  context.agents.state.agentsList = makeBootRoster({
    agents: ["main", "other"].map((id) => ({ id })),
  });
  const selection = context.settingsAgentSelection;
  selection.set("main");
  const provider = createSolidApplicationContextProvider(context);
  const { container: element } = mountSolid(() => <PersonalInstructions />, {
    wrapper: provider.wrapper,
  });
  return { selection, emit: harness.emitSnapshot.bind(harness), element };
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
async function loaded(request = replies({}), scopes: string[] = hello.auth.scopes) {
  const harness = mount(request, true, true, scopes);
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
  return waitForSolid(() => expect(busy(element)).toBeNull());
}
const busy = (element: HTMLElement) => element.querySelector('[aria-busy="true"]');
const textarea = (element: HTMLElement) => element.querySelector("textarea");
const alert = (element: HTMLElement) => element.querySelector('[role="alert"]');
const value = (element: HTMLElement) => textarea(element)?.value;
const waitForValue = (element: HTMLElement, content: string) =>
  waitForSolid(() => expect(value(element)).toBe(content));

function pendingSave(element: HTMLElement, request: ReturnType<typeof replies>) {
  return waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(busy(element)).not.toBeNull();
    expect(button(element, "Saving…")).toMatchObject({ disabled: true });
  });
}
function expectSave(request: ReturnType<typeof replies>, content: string, hash: string | null) {
  expect(request).toHaveBeenLastCalledWith("users.personalFile.set", {
    agentId: "main",
    content,
    expectedHash: hash,
  });
}
function button(element: HTMLElement, text: string) {
  return [...element.querySelectorAll("button")].find((el) => el.textContent?.trim() === text)!;
}
async function input(element: HTMLElement, content: string) {
  const editor = textarea(element)!;
  editor.value = content;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

it.each(["operator.read", "operator.sessions.read"])(
  "creates the signed-in personal file with %s",
  async (scope) => {
    const initial = { ...file, content: "", hash: null, missing: true };
    const content = "New file";
    const request = replies(initial, { content, hash: "hash-2" });
    const { element } = await loaded(request, [scope]);
    expect(request).toHaveBeenCalledWith("users.personalFile.get", { agentId: "main" });
    expect(button(element, "Save").disabled).toBe(true);
    expect(button(element, "Reload")).toBeUndefined();
    const editor = textarea(element);
    expect(editor?.getAttribute("aria-label")).toBe("Personal instructions");
    expect(editor?.getAttribute("aria-describedby")).toBe("personal-instructions-guidance");
    expect(element.textContent).toContain("created when you save");
    await input(element, "x".repeat(4001));
    expect(button(element, "Save").disabled).toBe(true);
    expect(alert(element)?.textContent).toContain("4,000");
    await save(element, content);
    expectSave(request, content, initial.hash);
    expect(element.textContent).toContain("Saved");
  },
);

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
    expect(textarea(element)).toBeNull();
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
  expect(value(element)).toBe("My draft");
  expect(alert(element)?.textContent).toContain("changed since read");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  button(element, "Reload").click();
  await idle(element);
  expect(request).toHaveBeenCalledTimes(2);
  confirm.mockReturnValue(true);
  button(element, "Reload").click();
  await idle(element);
  expect(value(element)).toBe("My draft");
  button(element, "Reload").click();
  await idle(element);
  expect(value(element)).toBe("External edit");
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
  expect(value(element)).not.toBe("Former person's draft");
});

it.each([
  ["agent", "other", "profile-1", false],
  ["profile", "main", "profile-2", false],
  ["connection hello", "main", "profile-1", false],
  ["connection hello", "main", "profile-1", true],
  ["access revoked", "main", "profile-1", false],
] as const)(
  "retires reads after %s (%s/%s, pending: %s)",
  async (change, agentId, profileId, pending) => {
    const old = createDeferred<PersonalFile>();
    const replacement = createDeferred<PersonalFile>();
    const current = { ...file, agentId, profileId, content: "Current instructions" };
    const request = replies(old.promise, pending ? replacement.promise : current);
    const { element, selection, emit } = mount(request);
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledWith("users.personalFile.get", { agentId: "main" });
      expect(busy(element)).not.toBeNull();
    });
    if (change === "agent") {
      selection.set("other");
    } else if (change === "profile") {
      emit({ client: clientFile(current), selfUser: { id: "profile-2" } });
    } else if (change === "access revoked") {
      emit({ hello: { ...hello, auth: { role: "operator", scopes: [] } } });
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
      expect(textarea(element)).toBeNull();
      expect(button(element, "Save").disabled).toBe(true);
      replacement.resolve(current);
    }
    await idle(element);
    if (change === "access revoked") {
      expect(textarea(element)).toBeNull();
      return;
    }
    expect(value(element)).toBe(current.content);
    if (pending) {
      await input(element, "New draft");
      expect(value(element)).toBe("New draft");
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
  await pendingSave(element, request);
  expectSave(request, "Old draft", file.hash);
  emit({
    client: clientFile({ content: "Current connection" }),
  });
  await idle(element);
  saving.resolve({ ...file, content: "Old draft" });
  await saving.promise;
  await idle(element);
  expect(value(element)).toBe("Old draft");
  expect(element.textContent).toContain("Unsaved changes");
});

it.each(["success", "failure"])(
  "preserves newer edits after returning to a pending save: %s",
  async (outcome) => {
    const saving = createDeferred<typeof file>();
    const request = replies(
      {},
      saving.promise,
      { agentId: "other", content: "Other instructions" },
      { content: outcome === "success" ? file.content : "Second edit", hash: "hash-3" },
    );
    const { element, selection } = await loaded(request);
    expect(value(element)).toBe(file.content);
    await input(element, "First edit");
    button(element, "Save").click();
    await pendingSave(element, request);
    selection.set("other");
    await waitForValue(element, "Other instructions");
    selection.set("main");
    await waitForValue(element, "First edit");
    await input(element, "Second edit");
    if (outcome === "success") {
      saving.resolve({ ...file, content: "First edit", hash: "hash-2" });
      await saving.promise;
      flush();
    } else {
      saving.reject(new Error("Save rejected after returning"));
      await waitForSolid(() => expect(alert(element)?.textContent).toContain("Save rejected"));
    }
    expect(value(element)).toBe("Second edit");
    expect(element.textContent).toContain("Unsaved changes");
    expect(button(element, "Save").disabled).toBe(false);
    if (outcome === "success") {
      await input(element, file.content);
      expect(button(element, "Save").disabled).toBe(false);
    }
    button(element, "Save").click();
    expectSave(
      request,
      outcome === "success" ? file.content : "Second edit",
      outcome === "success" ? "hash-2" : file.hash,
    );
    await waitForSolid(() => expect(element.textContent).toContain("Saved"));
  },
);

it("rejects a response for a different profile rather than enabling a save", async () => {
  const request = vi.fn().mockResolvedValue({ ...file, profileId: "someone-else" });
  const { element } = await loaded(request);
  expect(textarea(element)).toBeNull();
  expect(button(element, "Save").disabled).toBe(true);
  expect(alert(element)?.textContent).toContain("does not match");
});

it("clears a prior profile read error while the replacement read is pending", async () => {
  const { element, emit } = await loaded(replies(new Error("Previous profile read failed")));
  expect(alert(element)?.textContent).toContain("Previous profile");
  const replacement = createDeferred<PersonalFile>();
  emit({
    selfUser: { id: "profile-2" },
    client: createTestGatewayClient(vi.fn().mockReturnValue(replacement.promise)),
  });
  await waitForSolid(() => {
    expect(alert(element)).toBeNull();
    expect(busy(element)).not.toBeNull();
  });
  replacement.resolve({ ...file, profileId: "profile-2", content: "Current profile instructions" });
  await idle(element);
  expect(value(element)).toBe("Current profile instructions");
});

it("retains drafts privately while offline and restores them only for the same profile", async () => {
  const request = vi.fn().mockResolvedValue(file);
  const { element, emit } = await loaded(request);
  await input(element, "Keep my unsaved instructions");
  emit({ phase: "offline", selfUser: null });
  await idle(element);
  expect(textarea(element)).toBeNull();
  emit({ phase: "connected", selfUser: null });
  await idle(element);
  expect(textarea(element)).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  emit({ phase: "connected", selfUser: { id: "profile-1" } });
  await idle(element);
  expect(value(element)).toBe("Keep my unsaved instructions");
  expect(request).toHaveBeenCalledTimes(1);
  emit({ phase: "offline", selfUser: null });
  emit({ phase: "connected", selfUser: null });
  await idle(element);
  expect(textarea(element)).toBeNull();
  emit({
    client: clientFile({ profileId: "profile-2", content: "Other person" }),
    selfUser: { id: "profile-2" },
  });
  await idle(element);
  expect(value(element)).toBe("Other person");
});
