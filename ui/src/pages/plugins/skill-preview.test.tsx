/* @vitest-environment jsdom */
import { createRoot, createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { PluginsSkillsReadResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createPluginPreview, PluginSkillPreview } from "./skill-preview.tsx";

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

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
  return { preview, request, gateway, publish, client, container: view.container };
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

it("opens before inventory settles and retains its shell across inventory failure and retry", async () => {
  const { preview, request, container } = setup();
  const initial = createDeferred<PluginsSkillsReadResult>();
  const retry = createDeferred<PluginsSkillsReadResult>();
  request.mockReturnValueOnce(initial.promise).mockReturnValueOnce(retry.promise);
  const pending = preview.open(params);
  await waitForSolid(() =>
    expect(container.querySelector(".body")?.getAttribute("aria-busy")).toBe("true"),
  );
  const shell = ["openclaw-file-preview-modal", ".head", ".body", ".list"].map((selector) =>
    container.querySelector(selector),
  );
  expect(container.querySelectorAll("openclaw-panel-loading-skeleton")).toHaveLength(2);
  expect(container.querySelector(".close-button")).not.toBeNull();
  initial.reject(new Error("Inventory failed"));
  await pending;
  await waitForSolid(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Inventory failed"),
  );
  expect(container.querySelector(".body")?.getAttribute("aria-busy")).toBe("false");
  container.querySelector<HTMLButtonElement>(".detail button")!.click();
  await waitForSolid(() =>
    expect(container.querySelector(".body")?.getAttribute("aria-busy")).toBe("true"),
  );
  expect(container.querySelectorAll("openclaw-panel-loading-skeleton")).toHaveLength(2);
  retry.resolve(lazyResult);
  await waitForSolid(() =>
    expect(container.querySelector(".markdown")?.textContent).toContain("Full instructions."),
  );
  ["openclaw-file-preview-modal", ".head", ".body", ".list"].forEach((selector, index) => {
    expect(container.querySelector(selector)).toBe(shell[index]);
  });
});

it("keeps selected-file failures retryable without refetching the entry or losing the inventory", async () => {
  const { preview, request, container } = setup();
  const selected = createDeferred<PluginsSkillsReadResult>();
  const retry = createDeferred<PluginsSkillsReadResult>();
  request
    .mockResolvedValueOnce({
      ...lazyResult,
      files: [
        { ...lazyResult.files[0]!, content: "[Configuration](a.md)" },
        ...lazyResult.files.slice(1),
      ],
    })
    .mockReturnValueOnce(selected.promise)
    .mockReturnValueOnce(retry.promise);
  await preview.open(params);
  await waitForSolid(() => expect(container.querySelector(".markdown a")).not.toBeNull());
  const modal = container.querySelector("openclaw-file-preview-modal");
  container.querySelector<HTMLAnchorElement>(".markdown a")!.click();
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  await waitForSolid(() =>
    expect(
      container.querySelectorAll('openclaw-panel-loading-skeleton[data-panel-skeleton="document"]'),
    ).toHaveLength(1),
  );
  expect(container.querySelectorAll(".item")).toHaveLength(3);
  expect(container.querySelector("openclaw-file-preview-modal")).toBe(modal);
  selected.reject(new Error("Read failed"));
  await waitForSolid(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Read failed"),
  );
  expect(container.querySelectorAll(".item")).toHaveLength(3);
  expect(preview.state?.result?.files[0]?.content).toBe("[Configuration](a.md)");
  container.querySelector<HTMLButtonElement>(".detail button")!.click();
  await waitForSolid(() =>
    expect(container.querySelector(".body")?.getAttribute("aria-busy")).toBe("true"),
  );
  expect(container.querySelectorAll(".item")).toHaveLength(3);
  expect(container.querySelectorAll("openclaw-panel-loading-skeleton")).toHaveLength(1);
  retry.resolve(selectedResult("a.md"));
  await waitForSolid(() =>
    expect(container.querySelector(".markdown")?.textContent).toContain("a.md"),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(request).toHaveBeenLastCalledWith("plugins.skills.read", {
    ...params,
    version: "1.0.0",
    path: "a.md",
  });
});

it("keeps an unavailable body retryable when it arrives in the inventory or a selected-file reply", async () => {
  const { preview, request, container } = setup();
  const unavailable: PluginsSkillsReadResult = {
    ...result,
    files: [{ ...result.files[0]!, status: "unavailable", content: undefined }],
  };
  request.mockResolvedValueOnce(unavailable).mockResolvedValueOnce(unavailable);
  await preview.open(params);
  await waitForSolid(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  expect(container.querySelectorAll(".item")).toHaveLength(1);
  container.querySelector<HTMLButtonElement>(".detail button")!.click();
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  await waitForSolid(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  expect(container.querySelector(".detail button")).not.toBeNull();
  expect(request).toHaveBeenLastCalledWith("plugins.skills.read", { ...params, path: "SKILL.md" });
});

it("clears an entry error when selecting a non-fetchable inventory sibling", async () => {
  const { preview, request, container } = setup();
  request.mockResolvedValueOnce({
    ...result,
    files: [
      { ...result.files[0]!, status: "unavailable", content: undefined },
      { path: "large.md", sizeBytes: 1_000_000, status: "too-large" },
    ],
  });
  await preview.open(params);
  await waitForSolid(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  const modal = container.querySelector("openclaw-file-preview-modal");

  container.querySelector<HTMLButtonElement>('.item[data-path="large.md"]')!.click();

  await waitForSolid(() =>
    expect(container.querySelector('.detail [role="status"]')?.textContent).toContain(
      "exceeds the preview limit",
    ),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector("openclaw-file-preview-modal")).toBe(modal);
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
