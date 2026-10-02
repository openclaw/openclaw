/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { PersonalInstructions } from "./personal-instructions.ts";
import { createConnectedContext, mountProfilePage } from "./profile-page.test-support.ts";

const file = {
  agentId: "main",
  profileId: "profile-1",
  content: "Keep it concise.",
  hash: "hash-1",
  missing: false,
};
const tag = "test-personal-instructions";
if (!customElements.get(tag)) {
  customElements.define(tag, class extends PersonalInstructions {});
}
beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mount(request: GatewayBrowserClient["request"], signedIn = true, multipleProfiles = true) {
  const base = createConnectedContext(
    request,
    signedIn ? { id: "profile-1", name: "Ada" } : null,
  ).context;
  let snapshot: ApplicationGatewaySnapshot = {
    ...base.gateway.snapshot,
    hello: {
      type: "hello-ok",
      protocol: 3,
      server: { connId: "connection-1" },
      snapshot: {},
      policy: { hasMultipleSessionSharingIdentities: multipleProfiles },
      auth: { role: "operator", scopes: ["operator.read"] },
    },
  };
  const listeners = new Set<() => void>();
  const agents: ApplicationContext["agents"] = {
    ...base.agents,
    state: {
      ...base.agents.state,
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          { id: "other", name: "Other" },
        ],
      },
    },
  };
  const selection = createAgentSelectionCapability(base.gateway, agents, undefined, undefined, {
    requireConfiguredAgent: true,
  });
  const context: ApplicationContext = {
    ...base,
    agents,
    settingsAgentSelection: selection,
    gateway: {
      ...base.gateway,
      get snapshot() {
        return snapshot;
      },
      subscribe(listener) {
        const notify = () => listener(snapshot);
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
    },
  };
  const provider = createApplicationContextProvider(context);
  const element = document.createElement(tag) as PersonalInstructions;
  provider.append(element);
  document.body.append(provider);
  return {
    element,
    selection,
    emit: (patch: Partial<ApplicationGatewaySnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      listeners.forEach((listener) => listener());
    },
  };
}
async function settle(element: PersonalInstructions) {
  await Promise.resolve();
  await element.updateComplete;
}
function button(element: HTMLElement, text: string) {
  return [...element.querySelectorAll("button")].find((el) => el.textContent?.trim() === text)!;
}
async function input(element: PersonalInstructions, value: string) {
  const editor = element.querySelector("textarea")!;
  editor.value = value;
  editor.dispatchEvent(new Event("input"));
  await element.updateComplete;
}

it("loads and saves only the signed-in personal file with operator.read", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(file)
    .mockResolvedValueOnce({ ...file, content: "Draft", hash: "hash-2" });
  const { element } = mount(request);
  await settle(element);
  expect(request).toHaveBeenCalledWith("users.personalFile.get", { agentId: "main" });
  expect(button(element, "Save").disabled).toBe(true);
  expect(button(element, "Reload")).toBeUndefined();
  await input(element, "Draft");
  button(element, "Save").click();
  await settle(element);
  expect(request).toHaveBeenLastCalledWith("users.personalFile.set", {
    agentId: "main",
    content: "Draft",
    expectedHash: "hash-1",
  });
  expect(element.textContent).toContain("Saved");
  expect(button(element, "Reload")).toBeUndefined();
});

it("shows one section heading without repeating it inside the editor card", async () => {
  const { element } = mount(vi.fn().mockResolvedValue(file));
  await settle(element);
  const heading = element.querySelector(".settings-section__heading");
  const editor = element.querySelector("textarea");
  expect(heading?.textContent?.trim()).toBe("Personal instructions");
  expect(element.querySelectorAll(".settings-section__heading")).toHaveLength(1);
  expect(element.querySelector(".personal-instructions label")).toBeNull();
  expect(editor?.getAttribute("aria-label")).toBe("Personal instructions");
  expect(editor?.getAttribute("aria-describedby")).toBe("personal-instructions-guidance");
  expect(editor?.rows).toBe(7);
});

it("never loads a personal file without a signed-in profile", async () => {
  const request = vi.fn();
  const { element } = mount(request, false);
  await settle(element);
  expect(request).not.toHaveBeenCalled();
  expect(element.querySelector("textarea")).toBeNull();
});

it("creates missing files with a null expected hash and rejects oversized drafts locally", async () => {
  const request = vi.fn().mockResolvedValue({ ...file, content: "", hash: null, missing: true });
  const { element } = mount(request);
  await settle(element);
  expect(element.textContent).toContain("created when you save");
  await input(element, "x".repeat(4001));
  expect(button(element, "Save").disabled).toBe(true);
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("4,000");
  await input(element, "New file");
  button(element, "Save").click();
  await settle(element);
  expect(request).toHaveBeenLastCalledWith("users.personalFile.set", {
    agentId: "main",
    content: "New file",
    expectedHash: null,
  });
});

it("offers recovery after an automatic load fails, then hides it after retry", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(file);
  const { element } = mount(request);
  await settle(element);
  expect(request).toHaveBeenCalledWith("users.personalFile.get", { agentId: "main" });
  expect(element.querySelector("textarea")).toBeNull();
  expect(button(element, "Reload")).toBeDefined();
  button(element, "Reload").click();
  await settle(element);
  expect(request).toHaveBeenCalledTimes(2);
  expect(element.querySelector("textarea")?.value).toBe(file.content);
  expect(button(element, "Reload")).toBeUndefined();
});

it("preserves a conflicting draft, confirms reload, and keeps it when reload fails", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(file)
    .mockRejectedValueOnce(new Error("Personal USER.md changed since read"))
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({ ...file, content: "External edit", hash: "hash-new" });
  const { element } = mount(request);
  await settle(element);
  await input(element, "My draft");
  button(element, "Save").click();
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe("My draft");
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("changed since read");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  button(element, "Reload").click();
  await settle(element);
  expect(request).toHaveBeenCalledTimes(2);
  confirm.mockReturnValue(true);
  button(element, "Reload").click();
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe("My draft");
  button(element, "Reload").click();
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe("External edit");
  expect(button(element, "Reload")).toBeUndefined();
});

it("follows the global Settings agent without a second selector or leaking unsaved drafts", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(file)
    .mockResolvedValueOnce({ ...file, agentId: "other", content: "Other instructions" });
  const { element, selection } = mount(request);
  await settle(element);
  expect(element.querySelector("select")).toBeNull();
  await input(element, "Main draft");
  selection.set("other");
  await settle(element);
  expect(request).toHaveBeenLastCalledWith("users.personalFile.get", { agentId: "other" });
  expect(element.querySelector("textarea")?.value).toBe("Other instructions");
  expect(button(element, "Reload")).toBeUndefined();
  selection.set("main");
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe("Main draft");
  expect(element.textContent).toContain("Unsaved changes");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.some(([method]) => method === "users.personalFile.set")).toBe(false);
});

it("drops a cached draft after undoing back to the saved content", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(file)
    .mockResolvedValueOnce({ ...file, agentId: "other", content: "Other instructions" })
    .mockResolvedValueOnce({ ...file, agentId: "other", content: "Other instructions" })
    .mockResolvedValueOnce(file);
  const { element, selection } = mount(request);
  await settle(element);
  await input(element, "Unsaved main edit");
  selection.set("other");
  await settle(element);
  selection.set("main");
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe("Unsaved main edit");
  await input(element, file.content);
  selection.set("other");
  await settle(element);
  selection.set("main");
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe(file.content);
  expect(element.textContent).not.toContain("Unsaved changes");
  expect(request.mock.calls.map(([, params]) => params)).toEqual([
    { agentId: "main" },
    { agentId: "other" },
    { agentId: "other" },
    { agentId: "main" },
  ]);
});

it("never restores a former person's cached draft after an account change", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(file)
    .mockResolvedValueOnce({ ...file, agentId: "other", content: "Other agent" });
  const { element, selection, emit } = mount(request);
  await settle(element);
  await input(element, "Former person's draft");
  selection.set("other");
  await settle(element);
  emit({
    selfUser: { id: "profile-2" },
    client: createTestGatewayClient(
      vi.fn().mockResolvedValue({
        ...file,
        profileId: "profile-2",
        agentId: "other",
        content: "New person",
      }),
    ),
  });
  await settle(element);
  selection.set("main");
  await settle(element);
  expect(element.querySelector("textarea")?.value).not.toBe("Former person's draft");
});

it("ignores a late read for a previously selected agent", async () => {
  const old = createDeferred<typeof file>();
  const request = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ ...file, agentId: "other", content: "Other instructions" });
  const { element, selection } = mount(request);
  await settle(element);
  selection.set("other");
  await settle(element);
  old.resolve(file);
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe("Other instructions");
});

it("ignores an old connection read after the current profile changes", async () => {
  const old = createDeferred<typeof file>();
  const request = vi.fn().mockReturnValue(old.promise);
  const { element, emit } = mount(request);
  await settle(element);
  const newRequest = vi
    .fn()
    .mockResolvedValue({ ...file, profileId: "profile-2", content: "New profile" });
  emit({ client: createTestGatewayClient(newRequest), selfUser: { id: "profile-2" } });
  await settle(element);
  old.resolve(file);
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe("New profile");
});

it("retains the unsettled draft but ignores an old save completion after reconnecting", async () => {
  const saving = createDeferred<typeof file>();
  const request = vi.fn().mockResolvedValueOnce(file).mockReturnValueOnce(saving.promise);
  const { element, emit } = mount(request);
  await settle(element);
  await input(element, "Old draft");
  button(element, "Save").click();
  await settle(element);
  expect(
    element.querySelector<HTMLButtonElement>(".personal-instructions__actions button")?.disabled,
  ).toBe(true);
  emit({
    client: createTestGatewayClient(
      vi.fn().mockResolvedValue({ ...file, content: "Current connection" }),
    ),
  });
  await settle(element);
  saving.resolve({ ...file, content: "Old draft" });
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe("Old draft");
  expect(element.textContent).toContain("Unsaved changes");
});

it("rejects a response for a different profile rather than enabling a save", async () => {
  const request = vi.fn().mockResolvedValue({ ...file, profileId: "someone-else" });
  const { element } = mount(request);
  await settle(element);
  expect(element.querySelector("textarea")).toBeNull();
  expect(button(element, "Save").disabled).toBe(true);
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("does not match");
});

it("invalidates an old read when the same client receives a new connection hello", async () => {
  const old = createDeferred<typeof file>();
  const request = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ ...file, content: "Reconnected" });
  const { element, emit } = mount(request);
  await settle(element);
  emit({
    hello: {
      type: "hello-ok",
      protocol: 3,
      server: { connId: "connection-2" },
      snapshot: {},
      policy: { hasMultipleSessionSharingIdentities: true },
      auth: { role: "operator", scopes: ["operator.read"] },
    },
  });
  await settle(element);
  old.resolve(file);
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe("Reconnected");
});

it("retires a pending read after read access is revoked", async () => {
  const old = createDeferred<typeof file>();
  const { element, emit } = mount(vi.fn().mockReturnValue(old.promise));
  await settle(element);
  emit({
    hello: {
      type: "hello-ok",
      protocol: 3,
      server: { connId: "connection-1" },
      snapshot: {},
      policy: { hasMultipleSessionSharingIdentities: true },
      auth: { role: "operator", scopes: [] },
    },
  });
  old.resolve(file);
  await settle(element);
  expect(element.querySelector("textarea")).toBeNull();
});

it("retains drafts privately while offline and restores them only for the same profile", async () => {
  const request = vi.fn().mockResolvedValue(file);
  const { element, emit } = mount(request);
  await settle(element);
  await input(element, "Keep my unsaved instructions");
  emit({ phase: "offline", selfUser: null });
  await settle(element);
  expect(element.querySelector("textarea")).toBeNull();
  emit({ phase: "connected", selfUser: null });
  await settle(element);
  expect(element.querySelector("textarea")).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  emit({ phase: "connected", selfUser: { id: "profile-1" } });
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe("Keep my unsaved instructions");
  expect(request).toHaveBeenCalledTimes(1);
  emit({ phase: "offline", selfUser: null });
  emit({ phase: "connected", selfUser: null });
  await settle(element);
  expect(element.querySelector("textarea")).toBeNull();
  const otherRequest = vi
    .fn()
    .mockResolvedValue({ ...file, profileId: "profile-2", content: "Other person" });
  emit({ client: createTestGatewayClient(otherRequest), selfUser: { id: "profile-2" } });
  await settle(element);
  expect(element.querySelector("textarea")?.value).toBe("Other person");
});

it("keeps the actual Profile editor mounted across an offline transition", async () => {
  const base = createConnectedContext(vi.fn().mockResolvedValue(file), { id: "profile-1" });
  const context: ApplicationContext = {
    ...base.context,
    gateway: {
      ...base.context.gateway,
      get snapshot(): ApplicationGatewaySnapshot {
        return {
          ...base.context.gateway.snapshot,
          hello: {
            type: "hello-ok",
            protocol: 3,
            server: { connId: "connection-1" },
            snapshot: {},
            policy: { hasMultipleSessionSharingIdentities: true },
            auth: { role: "operator", scopes: ["operator.read"] },
          },
        };
      },
    },
    agents: {
      ...base.context.agents,
      state: {
        ...base.context.agents.state,
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }],
        },
      },
    },
  };
  const page = mountProfilePage({
    ...context,
    settingsAgentSelection: createAgentSelectionCapability(
      context.gateway,
      context.agents,
      undefined,
      undefined,
      { requireConfiguredAgent: true },
    ),
  });
  await page.updateComplete;
  const editor = page.querySelector<PersonalInstructions>("openclaw-personal-instructions")!;
  await settle(editor);
  await input(editor, "Keep this draft across a network interruption");
  base.emitConnected(false);
  await page.updateComplete;
  expect(page.querySelector("openclaw-personal-instructions")).toBe(editor);
  base.emitConnected(true);
  await page.updateComplete;
  await settle(editor);
  expect(editor.querySelector("textarea")?.value).toBe(
    "Keep this draft across a network interruption",
  );
});

it("hides the personal editor and sends no file requests on a single-user Gateway", async () => {
  const request = vi.fn().mockResolvedValue(file);
  const { element } = mount(request, true, false);
  await settle(element);
  expect(element.textContent?.trim()).toBe("");
  expect(element.querySelector("textarea")).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
