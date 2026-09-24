/* @vitest-environment jsdom */
import type { ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginsSkillsReadResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { PluginPreviewController } from "./skill-preview.ts";

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

describe("plugin skill preview requests", () => {
  it("opens immediately and preserves complete content", async () => {
    const { controller, request } = setup();
    const response = createDeferred<PluginsSkillsReadResult>();
    request.mockReturnValueOnce(response.promise);
    const pending = controller.open(params);
    expect(controller.state?.loading).toBe(true);
    response.resolve(result);
    await pending;
    expect(controller.state).toMatchObject({ loading: false, result, error: null });
  });

  it("shows a failed read and retries the same source", async () => {
    const { controller, request } = setup();
    request.mockRejectedValueOnce(new Error("Skill unavailable")).mockResolvedValueOnce(result);
    await controller.open(params);
    expect(controller.state).toMatchObject({
      loading: false,
      error: "Skill unavailable",
      result: null,
    });
    controller.retry();
    await vi.waitFor(() => expect(controller.state?.result).toEqual(result));
    expect(request).toHaveBeenLastCalledWith("plugins.skills.read", params);
  });

  it.each(["close", "selection", "reconnect"] as const)(
    "retires a late response after %s",
    async (change) => {
      const { controller, request, gateway, client } = setup();
      const response = createDeferred<PluginsSkillsReadResult>();
      request
        .mockReturnValueOnce(response.promise)
        .mockResolvedValueOnce({ ...result, name: "other" });
      const pending = controller.open(params);
      if (change === "close") {
        controller.close();
      } else if (change === "selection") {
        await controller.open({ ...params, skillName: "other" });
      } else {
        gateway.transition({ client, phase: "reconnecting" });
        gateway.transition({ client, phase: "connected" });
      }
      response.resolve(result);
      await pending;
      expect(controller.state?.result?.name).not.toBe("guide");
      if (change === "close") {
        expect(controller.state).toBeNull();
      }
    },
  );
});

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

it.each(["close", "reopen", "reconnect"])(
  "discards selected-file results after %s",
  async (change) => {
    const { controller, request, gateway, client } = setup();
    const response = createDeferred<PluginsSkillsReadResult>();
    request
      .mockResolvedValueOnce(lazyResult)
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce({ ...lazyResult, version: "2.0.0" });
    await controller.open(params);
    const pending = controller.select("a.md");
    if (change === "close") {
      controller.close();
    } else if (change === "reopen") {
      await controller.open(params);
    } else {
      gateway.transition({ client, phase: "reconnecting" });
      gateway.transition({ client, phase: "connected" });
    }
    response.resolve(selectedResult("a.md"));
    await pending;
    expect(
      controller.state?.result?.files.find((file) => file.path === "a.md")?.content,
    ).toBeUndefined();
  },
);
