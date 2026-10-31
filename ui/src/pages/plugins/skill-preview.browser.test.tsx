import { createSignal, lazy } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createPluginPreview, PluginSkillPreview } from "./skill-preview.tsx";
import "../../styles.css";

it("keeps a pending preview modal dismissible and retains focus when its code arrives", async () => {
  const moduleGate = Promise.withResolvers<void>();
  vi.doMock("../../components/file-preview-modal.tsx", (original) => ({
    FilePreviewModal: lazy(
      async () => {
        await moduleGate.promise;
        return original<typeof import("../../components/file-preview-modal.tsx")>();
      },
      { export: "FilePreviewModal" },
    ),
  }));
  onTestFinished(() => vi.doUnmock("../../components/file-preview-modal.tsx"));
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  vi.spyOn(client, "request").mockResolvedValue({
    name: "guide",
    rootPath: "skills/guide",
    entryPath: "SKILL.md",
    directories: [],
    inventoryComplete: true,
    files: [{ path: "SKILL.md", sizeBytes: 18, status: "ready", content: "Full instructions." }],
  });
  const { gateway, publish } = createApplicationGateway();
  publish({ ...gateway.snapshot, client, phase: "connected" });
  const binding = new GatewayPageBinding(vi.fn(), { getGateway: () => gateway });
  binding.connect();
  onTestFinished(() => binding.dispose());
  onTestFinished(() => moduleGate.resolve());
  onTestFinished(() => vi.restoreAllMocks());
  const view = mountSolid(() => {
    const [revision, setRevision] = createSignal(0);
    const preview = createPluginPreview(binding, () => setRevision((value) => value + 1));
    const state = () => {
      revision();
      return preview.state;
    };
    return (
      <>
        <button
          onClick={() =>
            void preview.open({ source: "installed", pluginId: "example", skillName: "guide" })
          }
        >
          Open skill
        </button>
        <PluginSkillPreview preview={preview} state={state()} />
      </>
    );
  });
  const trigger = page.getByRole("button", { name: "Open skill", exact: true });
  const dialog = page.getByRole("dialog", { name: "guide", exact: true });
  await trigger.click();
  await expect.element(dialog).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
  expect(view.container.querySelector("openclaw-modal-dialog")).toBeNull();

  await trigger.click();
  await expect.element(dialog).toHaveFocus();
  moduleGate.resolve();
  await expect.element(page.getByText("Full instructions.", { exact: true })).toBeVisible();
  await waitForSolid(() => {
    const preview = view.container.querySelector("openclaw-file-preview-modal");
    expect(preview?.contains(document.activeElement)).toBe(true);
    expect(view.container.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
  });
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
  expect(view.container.querySelector("openclaw-modal-dialog")).toBeNull();
});
