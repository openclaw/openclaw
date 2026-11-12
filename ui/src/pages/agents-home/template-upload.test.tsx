/* @vitest-environment jsdom */
import { fireEvent, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { ShellLayoutOwner } from "../../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../../app/shell-layout-traits-solid.tsx";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { TemplateUpload } from "./template-upload.tsx";
import type { TemplateAddReviewPlan } from "./templates-catalog-client.ts";

const gateway = vi.hoisted(() => ({
  plan: vi.fn(),
  apply: vi.fn(),
  refreshList: vi.fn(),
  navigate: vi.fn(),
  selectAgent: vi.fn(),
  setSessionKey: vi.fn(),
}));
vi.mock("../../lib/reactive/context.ts", () => ({
  useApplication: () => ({
    basePath: "",
    agents: { refreshList: gateway.refreshList, state: { agentsList: null } },
    gateway: { snapshot: { hello: null }, setSessionKey: gateway.setSessionKey },
    agentSelection: { state: { selectedId: "main" }, set: gateway.selectAgent },
    sessions: { state: { result: null, agentId: "main" } },
    navigate: gateway.navigate,
  }),
}));
vi.mock("../../lib/reactive/gateway-page.ts", () => ({
  useGatewayPage: () => ({
    snapshot: {
      client: {},
      phase: "connected",
      hello: {
        features: { methods: ["templates.add.apply"] },
        auth: { role: "operator", scopes: ["operator.admin"] },
      },
    },
    capture: () => ({ client: {} }),
    isCurrent: () => true,
  }),
}));
vi.mock("../../lib/blob-data-url.ts", () => ({
  readBlobAsDataUrl: async () => "data:application/gzip;base64,YQ==",
}));
vi.mock("./templates-catalog-client.ts", () => ({
  readTemplateAddReviewPlan: gateway.plan,
  applyTemplateAdd: gateway.apply,
}));

const plan: TemplateAddReviewPlan = {
  schemaVersion: "openclaw.templatesGatewayPlan.v1",
  operation: "add",
  planIntegrity: "review-integrity",
  target: { agentId: "example", name: "Example briefing" },
  actions: [],
  capabilities: [],
  pluginReviews: [],
  skillReviews: [],
  blockers: [],
  riskAcknowledgementRequired: false,
};
afterEach(() => {
  cleanupSolid();
  vi.clearAllMocks();
});

describe("TemplateUpload", () => {
  it("uses the shared mobile header and keeps import progress at the confirmation action", async ({
    onTestFinished,
  }) => {
    const planning = Promise.withResolvers<TemplateAddReviewPlan>();
    const applying = Promise.withResolvers<{ agentId: string; status: string }>();
    gateway.plan.mockReturnValue(planning.promise);
    gateway.apply.mockReturnValue(applying.promise);
    const owner = new ShellLayoutOwner();
    const slot = document.createElement("div");
    document.body.append(slot);
    onTestFinished(() => slot.remove());
    const view = mountSolid(() => (
      <ShellLayoutProvider value={{ owner, host: document.body }}>
        <TemplateUpload />
      </ShellLayoutProvider>
    ));
    expect(view.getByRole("button", { name: "Import", exact: true }).textContent).toContain(
      "Import",
    );
    const release = owner.registerHeaderActions(slot);
    flush();
    expect(view.container.querySelector('button[aria-label="Import"]')).toBeNull();
    const trigger = slot.querySelector<HTMLButtonElement>('button[aria-label="Import"]')!;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toBe("");
    expect(
      Array.from(trigger.querySelectorAll("svg path"), (path) => path.getAttribute("d")),
    ).toEqual([
      "M12 3v12",
      "m8 11 4 4 4-4",
      "M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4",
    ]);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, "click");
    trigger.click();
    expect(click).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { files: [new File(["archive"], "example.tgz")] } });
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Reviewing template…"));
    expect(view.container.querySelector(".template-import-skeleton-rows")).not.toBeNull();
    expect((view.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(view.container.querySelector(".oc-dialog__footer")?.textContent).toContain(
      "Reviewing template…",
    );
    planning.resolve(plan);
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Import template", exact: true })).toBeTruthy(),
    );
    const confirm = view.getByRole("button", {
      name: "Import template",
      exact: true,
    }) as HTMLButtonElement;
    confirm.click();
    flush();
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe("Importing…");
    expect(confirm.querySelector('.btn__spinner[aria-hidden="true"]')).not.toBeNull();
    expect(confirm.querySelector('[role="status"]')?.textContent).toBe("Importing…");
    expect(view.container.querySelector('.oc-dialog__body > [role="status"]')).toBeNull();
    expect((view.getByRole("button", { name: "Change file" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((view.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.disabled).toBe(true);
    expect(gateway.apply).toHaveBeenCalledWith(
      {},
      { kind: "upload", archiveBase64: "YQ==" },
      { reviewPlan: plan },
    );
    applying.resolve({ status: "complete", agentId: "example" });
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe("Installed agent: example"),
    );
    expect(view.getByRole("heading", { name: "Example briefing" })).toBeTruthy();
    const refreshing = Promise.withResolvers<AgentsListResult | null>();
    gateway.refreshList.mockReturnValue(refreshing.promise);
    const openChat = view.getByRole("button", {
      name: "Open chat",
      exact: true,
    }) as HTMLButtonElement;
    openChat.click();
    flush();
    expect(gateway.refreshList).toHaveBeenCalledOnce();
    expect(gateway.navigate).not.toHaveBeenCalled();
    expect(openChat.disabled).toBe(true);
    refreshing.resolve(makeBootRoster({ agents: [{ id: "example", name: "Example briefing" }] }));
    await waitFor(() =>
      expect(gateway.navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/example" }),
    );
    expect(gateway.selectAgent).toHaveBeenCalledWith("example");
    expect(gateway.setSessionKey).toHaveBeenCalledWith("agent:example:main");
    release();
    flush();
    expect(slot.querySelector("button")).toBeNull();
    view.unmount();
    slot.remove();
  });

  it("cancels a pending review and ignores its late result", async () => {
    const planning = Promise.withResolvers<TemplateAddReviewPlan>();
    gateway.plan.mockReturnValue(planning.promise);
    const view = mountSolid(() => <TemplateUpload />);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["archive"], "example.tgz")] } });
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Reviewing template…"));
    const cancel = view.getByRole("button", { name: "Cancel", exact: true }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    cancel.click();
    planning.resolve(plan);
    await planning.promise;
    flush();
    expect(view.container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(gateway.apply).not.toHaveBeenCalled();
  });

  it("offers Change file after an invalid archive without requesting a plan", async () => {
    const view = mountSolid(() => <TemplateUpload />);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const choose = vi.spyOn(input, "click");
    fireEvent.change(input, { target: { files: [new File(["archive"], "wrong.txt")] } });
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain(".tgz"));
    const change = view.getAllByRole("button", { name: "Change file", exact: true }).at(-1)!;
    change.click();
    expect(choose).toHaveBeenCalledOnce();
    expect(gateway.plan).not.toHaveBeenCalled();
    expect(gateway.apply).not.toHaveBeenCalled();
  });

  it("does not offer Change file or another apply after an uncertain installation failure", async () => {
    gateway.plan.mockResolvedValue(plan);
    gateway.apply.mockRejectedValue(new Error("Connection lost after submission"));
    const view = mountSolid(() => <TemplateUpload />);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["archive"], "example.tgz")] } });
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Import template", exact: true })).toBeTruthy(),
    );
    view.getByRole("button", { name: "Import template", exact: true }).click();
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Connection lost"));
    expect(view.queryByRole("button", { name: "Change file", exact: true })).toBeNull();
    expect(view.queryByRole("button", { name: "Import template", exact: true })).toBeNull();
    expect(gateway.apply).toHaveBeenCalledOnce();
  });
});
