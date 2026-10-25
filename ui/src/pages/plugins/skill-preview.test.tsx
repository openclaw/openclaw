/* @vitest-environment jsdom */
import { createRoot, createSignal } from "solid-js";
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
  const { preview, state } = createRoot((dispose) => {
    onTestFinished(dispose);
    const [revision, setRevision] = createSignal(0);
    const owner = createPluginPreview(binding, () => setRevision((value) => value + 1));
    return {
      preview: owner,
      state: () => {
        revision();
        return owner.state;
      },
    };
  });
  const view = mountSolid(() => <PluginSkillPreview preview={preview} state={state()} />);
  const find = view.container.querySelector.bind(view.container);
  const count = (selector: string, expected: number) =>
    expect(view.container.querySelectorAll(selector)).toHaveLength(expected);
  const busy = (value: boolean) =>
    waitForSolid(() => expect(find(".body")?.getAttribute("aria-busy")).toBe(String(value)));
  const text = (selector: string, value: string) =>
    waitForSolid(() => expect(find(selector)?.textContent).toContain(value));
  const error = (value: string) =>
    waitForSolid(() => expect(find('[role="alert"]')?.textContent).toBe(value));
  const retry = () => find<HTMLButtonElement>(".detail button")!.click();
  return { preview, request, gateway, publish, find, count, busy, text, error, retry };
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
  files: [...result.files, ...["a.md", "b.md"].map(deferredFile)],
};
function deferredFile(path: string): PluginsSkillsReadResult["files"][number] {
  return { path, sizeBytes: 1, status: "deferred" };
}
const unavailable: PluginsSkillsReadResult = {
  ...result,
  files: [{ ...result.files[0]!, status: "unavailable", content: undefined }],
};
const selectedResult = (path: string): PluginsSkillsReadResult => ({
  ...lazyResult,
  files: lazyResult.files.map((file) =>
    file.path === path
      ? { ...file, status: "ready", content: path }
      : { ...file, status: "deferred", content: undefined },
  ),
});

it.each([false, true])(
  "releases preview readiness on close before the retired request settles (selected file: %s)",
  async (selectedFile) => {
    const { preview, request } = setup();
    const response = createDeferred<PluginsSkillsReadResult>();
    if (selectedFile) {
      request.mockResolvedValueOnce(lazyResult);
      await preview.open(params);
    }
    request.mockReturnValueOnce(response.promise);
    const opened = selectedFile ? preview.select("a.md") : preview.open(params);
    const ready = selectedFile
      ? preview.state!.fileRequests.get("a.md")!.promise
      : preview.state!.inventoryRequest;
    preview.close();
    await ready;
    expect(preview.state).toBeNull();
    response.resolve(selectedFile ? selectedResult("a.md") : result);
    await opened;
    expect(preview.state).toBeNull();
  },
);

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

it.each([false, true])(
  "retains the shell across read failure and retry (selected file: %s)",
  async (selectedFile) => {
    const { preview, request, find, count, busy, text, error, retry: clickRetry } = setup();
    const initial = createDeferred<PluginsSkillsReadResult>();
    const retry = createDeferred<PluginsSkillsReadResult>();
    const entry = "[Configuration](a.md)";
    if (selectedFile) {
      request.mockResolvedValueOnce({
        ...lazyResult,
        files: [{ ...lazyResult.files[0]!, content: entry }, ...lazyResult.files.slice(1)],
      });
      await preview.open(params);
      await waitForSolid(() => expect(find(".markdown a")).not.toBeNull());
    }
    const selectors = ["openclaw-file-preview-modal", ".head", ".body", ".list"];
    const shell = selectedFile ? selectors.map((selector) => find(selector)) : [];
    request.mockReturnValueOnce(initial.promise).mockReturnValueOnce(retry.promise);
    const pending = selectedFile ? undefined : preview.open(params);
    if (selectedFile) {
      find<HTMLAnchorElement>(".markdown a")!.click();
      await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
      await waitForSolid(() =>
        count('openclaw-panel-loading-skeleton[data-panel-skeleton="document"]', 1),
      );
      count(".item", 3);
      expect(find(selectors[0]!)).toBe(shell[0]);
    } else {
      await busy(true);
      shell.push(...selectors.map((selector) => find(selector)));
      count("openclaw-panel-loading-skeleton", 2);
      expect(find(".close-button")).not.toBeNull();
    }
    initial.reject(new Error("Read failed"));
    await pending;
    await error("Read failed");
    if (selectedFile) {
      count(".item", 3);
      expect(preview.state?.result?.files[0]?.content).toBe(entry);
    } else {
      await busy(false);
    }
    clickRetry();
    await busy(true);
    if (selectedFile) {
      count(".item", 3);
    }
    count("openclaw-panel-loading-skeleton", selectedFile ? 1 : 2);
    retry.resolve(selectedFile ? selectedResult("a.md") : lazyResult);
    await text(".markdown", selectedFile ? "a.md" : "Full instructions.");
    selectors.forEach((selector, index) => expect(find(selector)).toBe(shell[index]));
    expect(find('[role="alert"]')).toBeNull();
    expect(request).toHaveBeenLastCalledWith("plugins.skills.read", {
      ...params,
      ...(selectedFile ? { version: "1.0.0", path: "a.md" } : {}),
    });
  },
);

it("keeps an unavailable body retryable when it arrives in the inventory or a selected-file reply", async () => {
  const { preview, request, find, count, retry } = setup();
  request.mockResolvedValueOnce(unavailable).mockResolvedValueOnce(unavailable);
  await preview.open(params);
  await waitForSolid(() => expect(find('[role="alert"]')).not.toBeNull());
  count(".item", 1);
  retry();
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  await waitForSolid(() => expect(find('[role="alert"]')).not.toBeNull());
  expect(find(".detail button")).not.toBeNull();
  expect(request).toHaveBeenLastCalledWith("plugins.skills.read", { ...params, path: "SKILL.md" });
});

it("clears an entry error when selecting a non-fetchable inventory sibling", async () => {
  const { preview, request, find, text } = setup();
  request.mockResolvedValueOnce({
    ...unavailable,
    files: [...unavailable.files, { path: "large.md", sizeBytes: 1_000_000, status: "too-large" }],
  });
  await preview.open(params);
  await waitForSolid(() => expect(find('[role="alert"]')).not.toBeNull());
  const modal = find("openclaw-file-preview-modal");

  find<HTMLButtonElement>('.item[data-path="large.md"]')!.click();

  await text('.detail [role="status"]', "exceeds the preview limit");
  expect(find('[role="alert"]')).toBeNull();
  expect(find("openclaw-file-preview-modal")).toBe(modal);
  expect(request).toHaveBeenCalledTimes(1);
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
