/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import * as lazyElements from "../app/lazy-custom-element.ts";
import {
  agentIds,
  mountRoster,
  roster,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../test-helpers/gateway-methods.ts";
import { waitForConfirmDialogActions, answerConfirmDialog } from "../test-helpers/modal-dialog.ts";
import {
  runSessionAction as runSession,
  runBatchSessionAction as runBatch,
  createSessionGroup,
  renameSessionGroupFromMenu as renameGroup,
  deleteSessionGroupFromMenu as deleteGroup,
  editSessionGroupDefaults as editDefaults,
} from "./session-organizer-menu.runtime.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "../lib/toast-host.tsx";

function failModalPreparation(error: Error, pending?: Promise<void>) {
  const get = customElements.get.bind(customElements);
  const lookup = vi
    .spyOn(customElements, "get")
    .mockImplementation((name) => (name === "openclaw-modal-dialog" ? undefined : get(name)));
  const ensure = lazyElements.ensureCustomElementDefined;
  const prepare = vi
    .spyOn(lazyElements, "ensureCustomElementDefined")
    .mockImplementation((name, load) =>
      name === "openclaw-modal-dialog" ? (pending ?? Promise.reject(error)) : ensure(name, load),
    );
  return () => {
    prepare.mockRestore();
    lookup.mockRestore();
  };
}

type DialogAction = (
  organizer: Parameters<typeof runSession>[0],
  row: Parameters<typeof runSession>[1],
) => Promise<unknown>;
it.each<[string, DialogAction]>([
  ["group delete", (owner) => deleteGroup(owner, "Drafts")],
  ["batch delete", (owner, row) => runBatch(owner, { kind: "delete" }, [row], false)],
  ["cloud worker stop", (owner, row) => runSession(owner, row, { kind: "stop-cloud-worker" })],
  ["session delete", (owner, row) => runSession(owner, row, { kind: "delete" })],
  [
    "batch archive",
    (owner, row) =>
      runBatch(owner, { kind: "toggle-archived" }, [{ ...row, hasActiveRun: true }], false),
  ],
  ["session rename", (owner, row) => runSession(owner, row, { kind: "rename" })],
  ["group create", (owner) => createSessionGroup(owner)],
  ["group rename", (owner) => renameGroup(owner, "Drafts")],
  ["group defaults", (owner) => editDefaults(owner, "Drafts")],
])("reports %s dialog preparation failure in the sidebar", async (_kind, run) => {
  const request = createGatewayRequestMock();
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({
    hello: gatewayHelloForMethods([
      ...SESSION_MUTATION_TEST_METHODS,
      "sessions.groups.delete",
      "sessions.reclaim",
    ]),
  });
  const sessions = createSessionsHarness("main", ["agent:main:draft"]);
  sessions.publish({
    groups: ["Drafts"],
    groupSettings: [{ name: "Drafts", position: 0, cwd: "/synthetic/work" }],
  });
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  sidebar.connected = true;
  await sidebar.updateComplete;
  const organizer = sidebar.sessionOrganizer;
  const row = {
    ...sidebar.findSidebarSessionByKey("agent:main:draft")!,
    hasActiveRun: false,
    cloudWorkerStopAction: {
      method: "sessions.reclaim" as const,
      requiredScope: "operator.write" as const,
      blocksActiveRun: true,
    },
  };
  const failure = new Error("Synthetic dialog preparation failed");
  failModalPreparation(failure);
  await expect(run(organizer, row)).resolves.toBeUndefined();
  await vi.waitFor(() =>
    expect(sidebar.querySelector('[role="alert"]')?.textContent).toContain(failure.message),
  );
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(sessions.deleteSession).not.toHaveBeenCalled();
  expect(sessions.deleteMany).not.toHaveBeenCalled();
  expect(sessions.patch).not.toHaveBeenCalled();
  expect(sessions.patchMany).not.toHaveBeenCalled();
  expect(sessions.groupsDelete).not.toHaveBeenCalled();
  expect(sessions.groupsPut).not.toHaveBeenCalled();
  expect(sessions.groupsRename).not.toHaveBeenCalled();
  expect(sessions.groupsUpdate).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([method]) => method === "sessions.reclaim")).toBe(false);
});

it("reports agent-delete dialog preparation failure and permits a safe retry", async () => {
  document.body.append(document.createElement("openclaw-toast-host"));
  const { sidebar, context, gatewayHarness, request } = await mountRoster(roster, []);
  context.agents.refreshList = vi.fn(async () => context.agents.state.agentsList);
  gatewayHarness.publish({
    hello: gatewayHelloForMethods([...SESSION_MUTATION_TEST_METHODS, "agents.delete"]),
  });
  sidebar.sidebarAgentsMode = "roster";
  await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
  await settleRoster(sidebar);
  const openDelete = async () => {
    sidebar.querySelector<HTMLButtonElement>('button[aria-label="Options for Harbor"]')!.click();
    await vi.waitFor(() => expect(sidebar.querySelector('[data-value="delete"]')).not.toBeNull());
    sidebar.querySelector<HTMLElement>('[data-value="delete"]')!.click();
  };
  const failure = new Error("Synthetic agent dialog preparation failed");
  const restore = failModalPreparation(failure);
  try {
    await openDelete();
    await vi.waitFor(() => expect(document.body.textContent).toContain(failure.message));
    expect(request).not.toHaveBeenCalledWith("agents.delete", expect.anything());
    expect(context.agents.refreshList).not.toHaveBeenCalled();
  } finally {
    restore();
  }
  await openDelete();
  answerConfirmDialog(await waitForConfirmDialogActions(), "cancel");
  expect(request).not.toHaveBeenCalledWith("agents.delete", expect.anything());
  expect(context.agents.refreshList).not.toHaveBeenCalled();
});

it("does not publish a retired group dialog preparation error to a replacement connection", async () => {
  const gateway = createGatewayHarness(createTestGatewayClient(createGatewayRequestMock()));
  const sessions = createSessionsHarness("main", ["agent:main:draft"]);
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  sidebar.connected = true;
  await sidebar.updateComplete;
  const preparation = Promise.withResolvers<void>();
  const failure = new Error("Retired dialog preparation failed");
  failModalPreparation(failure, preparation.promise);
  const pending = createSessionGroup(sidebar.sessionOrganizer);
  await vi.waitFor(() =>
    expect(lazyElements.ensureCustomElementDefined).toHaveBeenCalledWith(
      "openclaw-modal-dialog",
      expect.any(Function),
    ),
  );
  gateway.publish({ client: createTestGatewayClient(createGatewayRequestMock()) });
  await sidebar.updateComplete;
  preparation.reject(failure);
  await expect(pending).resolves.toBeUndefined();
  expect(sidebar.querySelector('[role="alert"]')).toBeNull();
  expect(sessions.groupsPut).not.toHaveBeenCalled();
});
