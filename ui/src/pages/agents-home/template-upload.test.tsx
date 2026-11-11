/* @vitest-environment jsdom */
import { fireEvent, waitFor } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellLayoutOwner } from "../../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../../app/shell-layout-traits-solid.tsx";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { TemplateUpload } from "./template-upload.tsx";
import type { TemplateAddReviewPlan } from "./templates-catalog-client.ts";

const gateway = vi.hoisted(() => ({ plan: vi.fn(), apply: vi.fn() }));
vi.mock("../../lib/reactive/context.ts", () => ({ useApplication: () => ({}) }));
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
  target: { agentId: "example" },
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
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, "click");
    trigger.click();
    expect(click).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { files: [new File(["archive"], "example.tgz")] } });
    await waitFor(() => expect(view.getByRole("status").textContent).toBe("Reviewing template…"));
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
    release();
    flush();
    expect(slot.querySelector("button")).toBeNull();
    view.unmount();
    slot.remove();
  });
});
