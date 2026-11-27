/* @vitest-environment jsdom */
import { createRoot } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { PluginsSkillsReadResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createPluginPreview, PluginSkillPreview } from "./skill-preview.tsx";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi.spyOn(client, "request");
  const { gateway, publish } = createApplicationGateway();
  publish({ ...gateway.snapshot, client, phase: "connected" });
  const binding = new GatewayPageBinding(vi.fn(), { getGateway: () => gateway });
  binding.connect();
  onTestFinished(() => binding.dispose());
  const preview = createRoot((dispose) => {
    onTestFinished(dispose);
    return createPluginPreview(binding);
  });
  const view = mountSolid(() => <PluginSkillPreview preview={preview} state={preview.read()} />);
  return { preview, request, view };
}

const params = { source: "installed", pluginId: "example", skillName: "guide" } as const;
const result: PluginsSkillsReadResult = {
  name: "guide",
  rootPath: "skills/guide",
  entryPath: "SKILL.md",
  directories: [],
  inventoryComplete: true,
  files: [{ path: "SKILL.md", sizeBytes: 18, status: "ready", content: "First skill." }],
};

it("does not replace the current skill when a dismissed read completes late", async () => {
  const { preview, request, view } = setup();
  const old = createDeferred<PluginsSkillsReadResult>();
  request.mockReturnValueOnce(old.promise).mockResolvedValueOnce({
    ...result,
    name: "second",
    files: [{ ...result.files[0]!, content: "Second skill." }],
  });
  const read = preview.open(params);
  preview.close();
  await preview.open({ ...params, skillName: "second" });
  old.resolve(result);
  await read;
  await waitForSolid(() => {
    expect(view.container.querySelector("article")?.textContent).toContain("Second skill.");
    expect(view.container.textContent).not.toContain("First skill.");
  });
});

it("retries an RPC failure against the original catalog release", async () => {
  const { preview, request, view } = setup();
  const catalog = {
    source: "catalog",
    catalogId: "ch_example",
    skillName: "guide",
    version: "2.1.0",
  } as const;
  request.mockRejectedValueOnce(new Error("Read failed")).mockResolvedValueOnce(result);
  await preview.open(catalog);
  await waitForSolid(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("Read failed"),
  );
  view.container.querySelector<HTMLButtonElement>("openclaw-modal-actions button")!.click();
  await waitForSolid(() =>
    expect(view.container.querySelector("article")?.textContent).toContain("First skill."),
  );
  expect(request.mock.calls).toEqual([
    ["plugins.skills.read", catalog],
    ["plugins.skills.read", catalog],
  ]);
});
