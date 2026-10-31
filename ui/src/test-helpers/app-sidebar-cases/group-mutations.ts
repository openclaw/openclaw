import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import * as groupDefaultsDialog from "../../components/session-group-defaults-dialog.tsx";
import "../../lib/toast-host.tsx";
import { editSessionGroupDefaults } from "../../components/session-organizer-menu.runtime.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SessionGroupMutationResult,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { createDataTransferStub } from "../drag-data.ts";
import { installDialogPolyfill, submitInputDialog } from "../modal-dialog.ts";
import "../../components/app-sidebar.tsx";
import { waitForFast } from "../wait-for.ts";

function requiredElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  return element!;
}

function dispatchDragEvent(
  target: Element,
  type: "dragstart" | "dragover" | "drop",
  dataTransfer: ReturnType<typeof createDataTransferStub>,
  clientY = 0,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientY: { value: clientY },
  });
  target.dispatchEvent(event);
}

describe("AppSidebar group mutation collapsed state", () => {
  const COLLAPSED_STORAGE_KEY = "openclaw:sidebar:sessions:collapsed-sections";
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => restoreDialogPolyfill());

  async function mountCollapsedGroup(options: {
    groupsRename?: () => Promise<SessionGroupMutationResult>;
    groupsDelete?: () => Promise<SessionGroupMutationResult>;
    client?: GatewayBrowserClient;
  }) {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(["category:Alpha"]));
    const gatewayHarness = createGatewayHarness(options.client ?? ({} as GatewayBrowserClient));
    const harness = createSessionsHarness("main", ["agent:main:main", "agent:main:alpha"]);
    harness.sessions.state.result!.sessions[1]!.category = "Alpha";
    if (options.groupsRename) {
      harness.groupsRename.mockImplementation(options.groupsRename);
    }
    if (options.groupsDelete) {
      harness.groupsDelete.mockImplementation(options.groupsDelete);
    }
    const { sidebar, provider } = await mountSidebar(gatewayHarness.gateway, harness.sessions);
    sidebar.connected = true;
    harness.publish({
      groups: ["Alpha"],
      sectionOrder: ["category:Alpha", "ungrouped", "groups", "work"],
    });
    await sidebar.updateComplete;
    return { sidebar, provider, harness, gatewayHarness };
  }

  async function openGroupMenu(sidebar: SidebarLifecycleState) {
    requiredElement(
      sidebar,
      '[data-session-section="category:Alpha"] .sidebar-session-group-actions[aria-haspopup="menu"]',
    ).click();
    await sidebar.updateComplete;
    return requiredElement(sidebar, ".sidebar-session-group-menu");
  }

  async function selectGroupMenuAction(sidebar: SidebarLifecycleState, value: string) {
    const menu = await openGroupMenu(sidebar);
    menu.querySelector<HTMLElement>(`[data-value="${value}"]`)!.click();
    await vi.dynamicImportSettled();
  }

  const dialogForm = (defaults: boolean) =>
    waitForFast(() => {
      const form = document.body.querySelector<HTMLFormElement>("openclaw-modal-dialog form");
      expect(form).not.toBeNull();
      if (defaults) {
        expect(form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
          false,
        );
      }
      return form!;
    });
  function expectNoGroupMutations(...harnesses: ReturnType<typeof createSessionsHarness>[]) {
    for (const harness of harnesses) {
      expect(harness.groupsRename).not.toHaveBeenCalled();
      expect(harness.groupsUpdate).not.toHaveBeenCalled();
    }
  }
  function reconnect(gateway: ReturnType<typeof createGatewayHarness>) {
    gateway.publish({ phase: "stopped" });
    gateway.publish({ phase: "connected" });
  }

  async function renameGroupThroughDialog(sidebar: SidebarLifecycleState, name: string) {
    await selectGroupMenuAction(sidebar, "rename-group");
    await waitForFast(() =>
      requiredElement(document.body, 'openclaw-modal-dialog input[name="value"]'),
    );
    await submitInputDialog(name);
    await vi.dynamicImportSettled();
  }

  function confirmButton() {
    return waitForFast(() =>
      requiredElement(document.body, "openclaw-modal-dialog .exec-approval-actions .btn.danger"),
    );
  }

  async function deleteGroupThroughConfirm(sidebar: SidebarLifecycleState) {
    await selectGroupMenuAction(sidebar, "delete-group");
    (await confirmButton()).click();
  }

  it.each([
    ["rename-group", "replacement"],
    ["group-defaults", "replacement"],
    ["rename-group", "reconnect"],
    ["group-defaults", "reconnect"],
  ])("keeps the correct owner for an open %s dialog on %s", async (action, transition) => {
    const client = () =>
      ({
        request: async (method: string) => {
          if (method === "worktrees.branches") {
            return { repositoryStatus: "not_git" };
          }
          throw new Error(`Unexpected group dialog request: ${method}`);
        },
      }) as unknown as GatewayBrowserClient;
    const { sidebar, provider, harness, gatewayHarness } = await mountCollapsedGroup({
      client: client(),
    });
    harness.publish({
      groupSettings: [{ name: "Alpha", position: 0, cwd: "/workspace/a", worktree: false }],
    });
    await sidebar.updateComplete;
    await selectGroupMenuAction(sidebar, action);
    const form = await dialogForm(action === "group-defaults");
    const input = form.querySelector<HTMLInputElement>('input[name="value"]');
    if (input) {
      input.value = "Beta";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const replacementGateway = createGatewayHarness(client());
    const replacement = createSessionsHarness("main", ["agent:main:main", "agent:main:alpha"]);
    replacement.sessions.state.result!.sessions[1]!.category = "Alpha";
    replacement.publish({
      groups: ["Alpha"],
      groupSettings: [{ name: "Alpha", position: 0, cwd: "/workspace/b", worktree: false }],
    });
    if (transition === "replacement") {
      provider.setContext(createContext(replacementGateway.gateway, replacement.sessions));
    } else {
      reconnect(gatewayHarness);
    }
    await sidebar.updateComplete;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.dynamicImportSettled();
    if (transition === "reconnect" && action === "rename-group") {
      await waitForFast(() =>
        expect(harness.groupsRename).toHaveBeenCalledExactlyOnceWith("Alpha", "Beta"),
      );
      await waitForFast(() =>
        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
      );
      expect(replacement.groupsRename).not.toHaveBeenCalled();
      return;
    }
    expectNoGroupMutations(harness, replacement);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();

    const current = transition === "replacement" ? replacement : harness;
    await selectGroupMenuAction(sidebar, action);
    if (action === "rename-group") {
      await submitInputDialog("Beta");
      await vi.dynamicImportSettled();
      await waitForFast(() =>
        expect(current.groupsRename).toHaveBeenCalledExactlyOnceWith("Alpha", "Beta"),
      );
    } else {
      const freshForm = await dialogForm(true);
      freshForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForFast(() =>
        expect(current.groupsUpdate).toHaveBeenCalledExactlyOnceWith("Alpha", {
          cwd: transition === "replacement" ? "/workspace/b" : "/workspace/a",
          worktree: false,
        }),
      );
    }
    await vi.dynamicImportSettled();
  });

  it.each([
    { operation: "rename", succeeds: false, expected: ["category:Alpha"] },
    { operation: "rename", succeeds: true, expected: ["category:Beta"] },
    { operation: "delete", succeeds: false, expected: ["category:Alpha"] },
    { operation: "delete", succeeds: true, expected: [] },
  ] as const)(
    "updates collapsed keys only after successful $operation (success: $succeeds)",
    async ({ operation, succeeds, expected }) => {
      const mutate = () =>
        succeeds
          ? Promise.resolve("completed" as const)
          : Promise.reject(new Error(operation + " failed"));
      const { sidebar, harness } = await mountCollapsedGroup(
        operation === "rename" ? { groupsRename: mutate } : { groupsDelete: mutate },
      );
      if (operation === "rename") {
        await renameGroupThroughDialog(sidebar, "Beta");
        await waitForFast(() => expect(harness.groupsRename).toHaveBeenCalledWith("Alpha", "Beta"));
      } else {
        await deleteGroupThroughConfirm(sidebar);
        await waitForFast(() => expect(harness.groupsDelete).toHaveBeenCalledWith("Alpha"));
      }
      if (operation === "rename" && !succeeds) {
        await waitForFast(() =>
          expect(
            document.body.querySelector("openclaw-modal-dialog [role=alert]")?.textContent,
          ).toContain("rename failed"),
        );
        expect(
          document.body.querySelector<HTMLInputElement>('openclaw-modal-dialog input[name="value"]')
            ?.value,
        ).toBe("Beta");
      }
      await Promise.resolve();
      await Promise.resolve();
      const stored = localStorage.getItem(COLLAPSED_STORAGE_KEY);
      if (succeeds) {
        expect(JSON.parse(stored ?? "[]")).toEqual(expected);
      } else {
        expect(stored).toBe(JSON.stringify(expected));
      }
    },
  );

  it("ignores a stale group rename after its Gateway reconnects with the same client", async () => {
    const rename = deferred<SessionGroupMutationResult>();
    const { sidebar, harness, gatewayHarness } = await mountCollapsedGroup({
      groupsRename: () => rename.promise,
    });
    await renameGroupThroughDialog(sidebar, "Beta");
    await waitForFast(() => expect(harness.groupsRename).toHaveBeenCalledWith("Alpha", "Beta"));

    reconnect(gatewayHarness);
    rename.resolve("stale");
    await waitForFast(() =>
      expect(
        document.body.querySelector("openclaw-modal-dialog [role=alert]")?.textContent,
      ).toContain("Connection changed"),
    );
    expect(
      document.body.querySelector<HTMLInputElement>('openclaw-modal-dialog input[name="value"]')
        ?.value,
    ).toBe("Beta");

    expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe(JSON.stringify(["category:Alpha"]));
  });

  it.each([false, true])(
    "leaves group deletion retryable after cancellation or reconnect (%s)",
    async (reconnected) => {
      const { sidebar, harness, gatewayHarness } = await mountCollapsedGroup({});
      const toast = reconnected
        ? document.body.appendChild(document.createElement("openclaw-toast-host"))
        : null;
      await toast?.updateComplete;
      await selectGroupMenuAction(sidebar, "delete-group");
      if (reconnected) {
        const confirm = await confirmButton();
        reconnect(gatewayHarness);
        confirm.click();
      } else {
        const cancel = await waitForFast(() => {
          const buttons = document.body.querySelectorAll<HTMLButtonElement>(
            "openclaw-modal-dialog .exec-approval-actions .btn",
          );
          expect(buttons).toHaveLength(2);
          return buttons[1]!;
        });
        cancel.click();
      }
      await waitForFast(() =>
        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
      );

      expect(harness.groupsDelete).not.toHaveBeenCalled();
      expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe(JSON.stringify(["category:Alpha"]));
      if (toast) {
        expect(harness.sessions.state).toMatchObject({
          groups: ["Alpha"],
          result: { sessions: [{}, { category: "Alpha" }] },
        });
        await waitForFast(() =>
          expect(toast.querySelector(".app-toast__message")?.textContent).toBe(
            'Gateway connection replaced before "Alpha" was deleted. Try again.',
          ),
        );
        toast.remove();
      }
    },
  );

  it.each(["folders", "repository"] as const)(
    "rejects %s inspection from a retired same-client connection",
    async (kind) => {
      const folders = { path: "/repos/client", home: "/home/peter", entries: [] };
      const repository = {
        branches: [{ kind: "local" as const, name: "main" }],
        defaultBranch: "main",
        repositoryStatus: "git" as const,
      };
      const result = deferred<typeof folders | typeof repository>();
      const client = {
        request: async (method: string) => {
          if (method === (kind === "folders" ? "fs.listDir" : "worktrees.branches")) {
            return await result.promise;
          }
          throw new Error("Unexpected request: " + method);
        },
      } as GatewayBrowserClient;
      const gatewayHarness = createGatewayHarness(client);
      const harness = createSessionsHarness("main", ["agent:main:main"]);
      const { sidebar } = await mountSidebar(gatewayHarness.gateway, harness.sessions);
      harness.sessions.state.groupSettings = [{ name: "Alpha", position: 0, cwd: "/repos/client" }];
      const opened =
        deferred<Parameters<typeof groupDefaultsDialog.showSessionGroupDefaultsDialog>[0]>();
      vi.spyOn(groupDefaultsDialog, "showSessionGroupDefaultsDialog").mockImplementation(
        async (options) => {
          opened.resolve(options);
        },
      );
      await editSessionGroupDefaults(sidebar.sessionOrganizer, "Alpha");
      const options = await opened.promise;
      const pending =
        kind === "folders"
          ? options.listDirectory("/repos/client")
          : options.inspectRepository("/repos/client");
      reconnect(gatewayHarness);
      result.resolve(kind === "folders" ? folders : repository);
      await expect(pending).rejects.toThrow(
        "Gateway connection replaced before the defaults were saved. Try again.",
      );
    },
  );

  it("disables only group actions whose exact method is unavailable", async () => {
    const { sidebar, harness, gatewayHarness } = await mountCollapsedGroup({});
    gatewayHarness.publish({
      hello: {
        auth: { role: "operator", scopes: ["operator.write"] },
        features: { methods: ["sessions.groups.put"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await sidebar.updateComplete;
    const menu = await openGroupMenu(sidebar);
    const rename = menu.querySelector<HTMLElement>('[data-value="rename-group"]');
    const create = menu.querySelector<HTMLElement>('[data-value="new-group"]');
    const remove = menu.querySelector<HTMLElement>('[data-value="delete-group"]');

    const disabled = [rename, create, remove].map((item) => item?.hasAttribute("disabled"));
    expect(disabled).toEqual([true, false, true]);

    rename?.click();
    remove?.click();

    expect(harness.groupsRename).not.toHaveBeenCalled();
    expect(harness.groupsDelete).not.toHaveBeenCalled();
  });
});

it("does not persist cross-group ordering when the catalog update fails", async () => {
  const groups = ["Alpha", "Beta"];
  const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
  const harness = createSessionsHarness("main", [
    "agent:main:main",
    "agent:main:work",
    ...groups.map((_, index) => `agent:main:group-${index}`),
  ]);
  const rows = harness.sessions.state.result!.sessions;
  rows[1]!.worktree = { id: "work", branch: "test", repoRoot: "/repo" };
  for (const [index, group] of groups.entries()) {
    rows[index + 2]!.category = group;
  }
  const { sidebar } = await mountSidebar(gatewayHarness.gateway, harness.sessions);
  sidebar.connected = true;
  harness.publish({ groups });
  await sidebar.updateComplete;
  const section = (id: string) => requiredElement(sidebar, `[data-session-section="${id}"]`);

  function renderedSectionIds(): string[] {
    return Array.from(sidebar.querySelectorAll<HTMLElement>("[data-session-section]")).flatMap(
      (element) => (element.dataset.sessionSection ? [element.dataset.sessionSection] : []),
    );
  }

  const before = renderedSectionIds();
  harness.groupsPut.mockRejectedValue(new Error("catalog update failed"));
  const dataTransfer = createDataTransferStub();
  dispatchDragEvent(
    requiredElement(section("category:Alpha"), ".sidebar-recent-sessions__head"),
    "dragstart",
    dataTransfer,
  );
  const coding = section("work");
  dispatchDragEvent(coding, "dragover", dataTransfer, -1);
  dispatchDragEvent(coding, "drop", dataTransfer, -1);
  await sidebar.updateComplete;

  await waitForFast(() =>
    expect(harness.groupsPut).toHaveBeenCalledWith(
      ["Beta", "Alpha"],
      ["category:Beta", "ungrouped", "groups", "category:Alpha", "work"],
    ),
  );
  await Promise.resolve();
  await sidebar.updateComplete;
  expect(renderedSectionIds()).toEqual(before);
});
