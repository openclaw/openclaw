/* @vitest-environment jsdom */
import { fireEvent, waitFor, within } from "@solidjs/testing-library";
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
  current: true,
}));
vi.mock("../../lib/reactive/context.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/reactive/context.ts")>()),
  useApplication: () => ({
    basePath: "",
    agents: { refreshList: gateway.refreshList, state: { agentsList: null } },
    gateway: { snapshot: { hello: null }, setSessionKey: gateway.setSessionKey },
    agentSelection: { state: { selectedId: "main" }, set: gateway.selectAgent },
    sessions: { state: { result: null, agentId: "main" } },
    navigate: gateway.navigate,
  }),
}));
vi.mock("../../lib/reactive/gateway-page.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/reactive/gateway-page.ts")>()),
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
    isCurrent: () => gateway.current,
  }),
}));
vi.mock("../../lib/blob-data-url.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/blob-data-url.ts")>()),
  readBlobAsDataUrl: async () => "data:application/gzip;base64,YQ==",
}));
vi.mock("./templates-catalog-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./templates-catalog-client.ts")>()),
  readTemplateAddReviewPlan: gateway.plan,
  applyTemplateUpload: gateway.apply,
}));

const plan: TemplateAddReviewPlan = {
  schemaVersion: "openclaw.templatesGatewayPlan.v1",
  operation: "add",
  planIntegrity: "review-integrity",
  target: { agentId: "example", name: "Example briefing" },
  reviewFiles: [],
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
  gateway.current = true;
});

function mountUpload(render = () => <TemplateUpload />) {
  const view = mountSolid(render);
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  return {
    ...view,
    input,
    choose: (name = "example.tgz") =>
      fireEvent.change(input, { target: { files: [new File(["archive"], name)] } }),
    button: (name: string) =>
      within(view.container.querySelector("openclaw-modal-dialog") ?? view.container).getByRole(
        "button",
        { name },
      ) as HTMLButtonElement,
  };
}
const consentDialog = async () =>
  within(
    await waitFor(() =>
      within(document.body).getByRole("dialog", { name: "Import Example briefing?" }),
    ),
  );

describe("TemplateUpload", () => {
  it("uses the mobile header, confirms reviewed consent, and opens the installed chat automatically", async ({
    onTestFinished,
  }) => {
    const planning = Promise.withResolvers<TemplateAddReviewPlan>();
    const applying = Promise.withResolvers<{
      agentId: string;
      status: string;
      sessionKey: string;
    }>();
    gateway.plan.mockReturnValue(planning.promise);
    gateway.apply.mockReturnValue(applying.promise);
    const owner = new ShellLayoutOwner();
    const slot = document.createElement("div");
    document.body.append(slot);
    onTestFinished(() => slot.remove());
    const view = mountUpload(() => (
      <ShellLayoutProvider value={{ owner, host: document.body }}>
        <TemplateUpload />
      </ShellLayoutProvider>
    ));
    expect(view.getAllByRole("button", { name: "Import" }).at(-1)!.textContent).toContain("Import");
    const release = owner.registerHeaderActions(slot);
    flush();
    expect(view.container.querySelector('button[aria-label="Import"]')).toBeNull();
    const trigger = slot.querySelector<HTMLButtonElement>('button[aria-label="Import"]')!;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toBe("");
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger.innerHTML).toContain("M12 5v14");
    const click = vi.spyOn(view.input, "click");
    trigger.click();
    expect(click).toHaveBeenCalledOnce();
    view.choose();
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Reviewing template…"));
    expect(view.container.querySelector(".template-import-skeleton")).not.toBeNull();
    expect(view.button("Cancel").disabled).toBe(false);
    expect(view.container.querySelector(".template-creator__footer")?.textContent).toContain(
      "Reviewing template…",
    );
    const reviewed = {
      ...plan,
      riskAcknowledgementRequired: true,
      trustWarning: "Package warning",
    };
    planning.resolve(reviewed);
    await waitFor(() => expect(view.button("Import")).toBeTruthy());
    const confirm = view.button("Import");
    confirm.click();
    const consent = await consentDialog();
    const submit = consent.getByRole("button", { name: "Import" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(gateway.apply).not.toHaveBeenCalled();
    consent.getByRole("checkbox").click();
    flush();
    expect(submit.disabled).toBe(false);
    submit.click();
    await waitFor(() => expect(gateway.apply).toHaveBeenCalledOnce());
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe("Importing…");
    expect(confirm.getAttribute("aria-label")).toBe("Importing…");
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.querySelector('.btn__spinner[aria-hidden="true"]')).not.toBeNull();
    expect(confirm.querySelector('[role="status"]')?.textContent).toBe("Importing…");
    expect(view.container.querySelector('.oc-dialog__body > [role="status"]')).toBeNull();
    expect(view.queryByRole("button", { name: "Change file" })).toBeNull();
    expect(view.button("Cancel").disabled).toBe(true);
    expect(trigger.disabled).toBe(true);
    expect(gateway.apply).toHaveBeenCalledWith(
      {},
      { kind: "upload", archiveBase64: "YQ==" },
      reviewed,
    );
    const refreshing = Promise.withResolvers<AgentsListResult | null>();
    gateway.refreshList.mockReturnValue(refreshing.promise);
    applying.resolve({ status: "complete", agentId: "example", sessionKey: "agent:example:main" });
    await waitFor(() => expect(gateway.refreshList).toHaveBeenCalledOnce());
    expect(gateway.navigate).not.toHaveBeenCalled();
    expect(confirm.disabled).toBe(true);
    refreshing.resolve(makeBootRoster({ agents: [{ id: "example", name: "Example briefing" }] }));
    await waitFor(() =>
      expect(gateway.navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/example" }),
    );
    expect(view.container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(gateway.selectAgent).toHaveBeenCalledWith("example");
    expect(gateway.setSessionKey).toHaveBeenCalledWith("agent:example:main");
    release();
    flush();
    expect(slot.querySelector("button")).toBeNull();
  });

  it("retries opening the saved chat without applying the archive again", async () => {
    gateway.plan.mockResolvedValue(plan);
    gateway.apply.mockResolvedValue({
      status: "complete",
      agentId: "example-2",
      sessionKey: "agent:example-2:welcome",
    });
    gateway.refreshList
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        makeBootRoster({ agents: [{ id: "example-2", name: "Example briefing 2" }] }),
      );
    const view = mountUpload();
    view.choose();
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Example briefing" })).toBeTruthy(),
    );
    view.button("Import").click();
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain("The agent was added"),
    );
    expect(gateway.navigate).not.toHaveBeenCalled();
    view.button("Retry opening chat").click();
    await waitFor(() =>
      expect(gateway.navigate).toHaveBeenCalledWith("chat", {
        pathname: "/chat/example-2/welcome",
      }),
    );
    expect(gateway.setSessionKey).toHaveBeenCalledWith("agent:example-2:welcome");
    expect(gateway.apply).toHaveBeenCalledOnce();
  });

  it("cancels a pending review and ignores its late result", async () => {
    const planning = Promise.withResolvers<TemplateAddReviewPlan>();
    gateway.plan.mockReturnValue(planning.promise);
    const view = mountUpload();
    view.choose();
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Reviewing template…"));
    expect(view.button("Cancel").disabled).toBe(false);
    view.button("Cancel").click();
    planning.resolve(plan);
    await planning.promise;
    flush();
    expect(view.container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(gateway.apply).not.toHaveBeenCalled();
  });

  it.each([
    { name: "wrong.txt", message: ".tgz", blocked: false },
    { name: "example.tgz", message: "The required plugin is blocked.", blocked: true },
  ])(
    "offers reselect without apply for $name (blocked=$blocked)",
    async ({ name, message, blocked }) => {
      gateway.plan.mockResolvedValue({
        ...plan,
        blockers: [{ code: "blocked", path: "plugins.research", message }],
      });
      const view = mountUpload();
      const choose = vi.spyOn(view.input, "click");
      view.choose(name);
      await waitFor(() => expect(view.getByRole("alert").textContent).toContain(message));
      view.button("Change file").click();
      expect(choose).toHaveBeenCalledOnce();
      expect(
        within(view.container.querySelector("openclaw-modal-dialog")!).queryByRole("button", {
          name: "Import",
        }),
      ).toBeNull();
      expect(gateway.plan).toHaveBeenCalledTimes(blocked ? 1 : 0);
      expect(gateway.apply).not.toHaveBeenCalled();
    },
  );

  it("does not offer Change file or another apply after an uncertain installation failure", async () => {
    gateway.plan.mockResolvedValue(plan);
    gateway.apply.mockRejectedValue(new Error("Connection lost after submission"));
    const view = mountUpload();
    view.choose();
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Example briefing" })).toBeTruthy(),
    );
    view.button("Import").click();
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Connection lost"));
    expect(view.queryByRole("button", { name: "Change file" })).toBeNull();
    expect(
      within(view.container.querySelector("openclaw-modal-dialog")!).queryByRole("button", {
        name: "Import",
      }),
    ).toBeNull();
    expect(gateway.apply).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "stale"])("does not apply %s package consent", async (outcome) => {
    gateway.plan.mockResolvedValue({
      ...plan,
      riskAcknowledgementRequired: true,
      trustWarning: "Package warning",
    });
    const view = mountUpload();
    view.choose();
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Example briefing" })).toBeTruthy(),
    );
    view.button("Import").click();
    const consent = await consentDialog();
    if (outcome === "stale") {
      consent.getByRole("checkbox").click();
      flush();
      gateway.current = false;
      consent.getByRole("button", { name: "Import" }).click();
      expect(gateway.apply).not.toHaveBeenCalled();
    }
    consent.getByRole("button", { name: "Cancel" }).click();
    await waitFor(() =>
      expect(
        within(document.body).queryByRole("dialog", { name: "Import Example briefing?" }),
      ).toBeNull(),
    );
    expect(gateway.apply).not.toHaveBeenCalled();
  });
});
