/* @vitest-environment jsdom */
import { createRoot } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { PluginsSkillsReadResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { createPluginPreview } from "./skill-preview.tsx";

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
    return createPluginPreview(binding, () => {});
  });
  return { preview, request, gateway, publish, client };
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
  const { preview, request } = setup();
  const a = createDeferred<PluginsSkillsReadResult>();
  const b = createDeferred<PluginsSkillsReadResult>();
  request
    .mockResolvedValueOnce(lazyResult)
    .mockReturnValueOnce(a.promise)
    .mockReturnValueOnce(b.promise);
  await preview.open(params);
  expect(request).toHaveBeenCalledTimes(1);
  const pendingA = preview.select("a.md");
  await preview.select("a.md");
  const pendingB = preview.select("b.md");
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
  expect(preview.state?.activePath).toBe("b.md");
  expect(preview.state?.result?.files.map((file) => file.content)).toEqual([
    "Full instructions.",
    "a.md",
    "b.md",
  ]);
  await preview.select("SKILL.md");
  await preview.select("a.md");
  expect(request).toHaveBeenCalledTimes(3);
});

it("keeps selected-file failures retryable without refetching the entry or losing the inventory", async () => {
  const { preview, request } = setup();
  request
    .mockResolvedValueOnce(lazyResult)
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValueOnce(selectedResult("a.md"));
  await preview.open(params);
  await preview.select("a.md");
  expect(preview.state?.fileErrors.get("a.md")).toBe("Read failed");
  expect(preview.state?.result?.files[0]?.content).toBe("Full instructions.");
  await preview.select("a.md");
  expect(preview.state?.fileErrors.size).toBe(0);
  expect(preview.state?.pendingPaths.size).toBe(0);
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
    const { preview, request, gateway, publish } = setup();
    const response = createDeferred<PluginsSkillsReadResult>();
    if (selectedFile) {
      request.mockResolvedValueOnce(lazyResult);
      await preview.open(params);
    }
    request
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(
        selectedFile ? { ...lazyResult, version: "2.0.0" } : { ...result, name: "other" },
      );
    const pending = selectedFile ? preview.select("a.md") : preview.open(params);
    if (change === "reopen") {
      await preview.open(params);
    } else if (change === "selection") {
      await preview.open({ ...params, skillName: "other" });
    } else {
      publish({ ...gateway.snapshot, phase: "reconnecting" });
      publish({ ...gateway.snapshot, phase: "connected" });
    }
    response.resolve(selectedFile ? selectedResult("a.md") : result);
    await pending;
    if (selectedFile) {
      expect(
        preview.state?.result?.files.find((file) => file.path === "a.md")?.content,
      ).toBeUndefined();
    } else {
      expect(preview.state?.result?.name).not.toBe("guide");
    }
  },
);
