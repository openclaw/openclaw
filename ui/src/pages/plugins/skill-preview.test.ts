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
