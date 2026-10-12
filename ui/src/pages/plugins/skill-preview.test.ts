/* @vitest-environment jsdom */
import type { ReactiveControllerHost } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginsSkillsReadResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { PluginPreviewController } from "./skill-preview.tsx";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const host = {
    addController() {},
    removeController() {},
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost;
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi.spyOn(client, "request");
  const gateway = createGatewayConnectionLifecycle({ client, phase: "connected" });
  const controller = new PluginPreviewController(host, gateway as unknown as GatewayPageController);
  return { controller, request, gateway, client };
}

const params = { source: "installed", pluginId: "example", skillName: "guide" } as const;
const result: PluginsSkillsReadResult = {
  name: "guide",
  rootPath: "skills/guide",
  entryPath: "SKILL.md",
  directories: [],
  inventoryComplete: true,
  files: [{ path: "SKILL.md", sizeBytes: 18, status: "ready", content: "Full instructions." }],
};

const lazyResult: PluginsSkillsReadResult = {
  ...result,
  version: "1.0.0",
  files: [
    ...result.files,
    { path: "a.md", sizeBytes: 1, status: "deferred" },
    { path: "b.md", sizeBytes: 1, status: "deferred" },
  ],
};
const selectedResult = (path: string): PluginsSkillsReadResult => ({
  ...lazyResult,
  files: lazyResult.files.map((file) =>
    file.path === path
      ? { ...file, status: "ready", content: path }
      : { ...file, status: "deferred", content: undefined },
  ),
});

it("fetches only selected bodies, deduplicates pending reads and retains late sibling bodies without changing selection", async () => {
  const { controller, request } = setup();
  const a = createDeferred<PluginsSkillsReadResult>();
  const b = createDeferred<PluginsSkillsReadResult>();
  request
    .mockResolvedValueOnce(lazyResult)
    .mockReturnValueOnce(a.promise)
    .mockReturnValueOnce(b.promise);
  await controller.open(params);
  expect(request).toHaveBeenCalledTimes(1);
  const pendingA = controller.select("a.md");
  await controller.select("a.md");
  const pendingB = controller.select("b.md");
  expect(request).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenLastCalledWith("plugins.skills.read", {
    ...params,
    version: "1.0.0",
    path: "b.md",
  });
  b.resolve(selectedResult("b.md"));
  await pendingB;
  a.resolve(selectedResult("a.md"));
  await pendingA;
  expect(controller.state?.activePath).toBe("b.md");
  expect(controller.state?.result?.files.map((file) => file.content)).toEqual([
    "Full instructions.",
    "a.md",
    "b.md",
  ]);
  await controller.select("SKILL.md");
  await controller.select("a.md");
  expect(request).toHaveBeenCalledTimes(3);
});

it("keeps selected-file failures retryable without refetching the entry or losing the inventory", async () => {
  const { controller, request } = setup();
  request
    .mockResolvedValueOnce(lazyResult)
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValueOnce(selectedResult("a.md"));
  await controller.open(params);
  await controller.select("a.md");
  expect(controller.state?.fileErrors.get("a.md")).toBe("Read failed");
  expect(controller.state?.result?.files[0]?.content).toBe("Full instructions.");
  await controller.select("a.md");
  expect(controller.state?.fileErrors.size).toBe(0);
  expect(controller.state?.pendingPaths.size).toBe(0);
  expect(request).toHaveBeenLastCalledWith("plugins.skills.read", {
    ...params,
    version: "1.0.0",
    path: "a.md",
  });
});

it.each([
  { selectedFile: false, change: "selection" },
  { selectedFile: false, change: "reconnect" },
  { selectedFile: true, change: "reopen" },
  { selectedFile: true, change: "reconnect" },
])(
  "retires late preview responses (selected file: $selectedFile, change: $change)",
  async ({ selectedFile, change }) => {
    const { controller, request, gateway, client } = setup();
    const response = createDeferred<PluginsSkillsReadResult>();
    if (selectedFile) {
      request.mockResolvedValueOnce(lazyResult);
      await controller.open(params);
    }
    request
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(
        selectedFile ? { ...lazyResult, version: "2.0.0" } : { ...result, name: "other" },
      );
    const pending = selectedFile ? controller.select("a.md") : controller.open(params);
    if (change === "reopen") {
      await controller.open(params);
    } else if (change === "selection") {
      await controller.open({ ...params, skillName: "other" });
    } else {
      gateway.transition({ client, phase: "reconnecting" });
      gateway.transition({ client, phase: "connected" });
    }
    response.resolve(selectedFile ? selectedResult("a.md") : result);
    await pending;
    if (selectedFile) {
      expect(
        controller.state?.result?.files.find((file) => file.path === "a.md")?.content,
      ).toBeUndefined();
    } else {
      expect(controller.state?.result?.name).not.toBe("guide");
    }
  },
);
