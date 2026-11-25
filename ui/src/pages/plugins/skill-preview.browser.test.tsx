import { expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createPluginPreview, PluginSkillPreview } from "./skill-preview.tsx";
import "../../styles.css";
import "../../styles/settings.css";

it("closes from the loading shell and restores focus to the invoking skill", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const pendingRead = Promise.withResolvers<never>();
  vi.spyOn(client, "request")
    .mockReturnValueOnce(pendingRead.promise)
    .mockResolvedValueOnce({
      name: "guide",
      rootPath: "skills/guide",
      entryPath: "SKILL.md",
      directories: [],
      inventoryComplete: true,
      files: [{ path: "SKILL.md", sizeBytes: 0, status: "unavailable" }],
    });
  const { gateway, publish } = createApplicationGateway();
  publish({ ...gateway.snapshot, client, phase: "connected" });
  const binding = new GatewayPageBinding(vi.fn(), { getGateway: () => gateway });
  binding.connect();
  onTestFinished(() => binding.dispose());
  onTestFinished(() => pendingRead.reject(new Error("Retired read")));
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const view = mountSolid(() => {
    const preview = createPluginPreview(binding);
    return (
      <>
        <button
          onClick={() =>
            void preview.open({ source: "installed", pluginId: "example", skillName: "guide" })
          }
        >
          Open skill
        </button>
        <PluginSkillPreview preview={preview} state={preview.read()} />
      </>
    );
  });
  const trigger = page.getByRole("button", { name: "Open skill", exact: true });
  const dialog = page.getByRole("dialog", { name: "guide", exact: true });
  (trigger.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("status", { name: "Loading…" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
  expect(view.container.querySelector("openclaw-modal-dialog")).toBeNull();

  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).toHaveTextContent("Couldn’t read SKILL.md.");
  await waitForSolid(() => {
    expect(view.container.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(trigger).toHaveFocus();
  expect(view.container.querySelector("openclaw-modal-dialog")).toBeNull();
});
