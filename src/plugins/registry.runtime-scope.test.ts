import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";
import { createPluginRuntimeMock } from "../../test/helpers/plugins/plugin-runtime-mock.ts";

describe("plugin runtime registry scoping", () => {
  it("wraps interSession.send with pluginId scope", async () => {
    const send = vi.fn(async () => ({
      messageRef: getPluginRuntimeGatewayRequestScope()?.pluginId ?? "missing-plugin-id",
    }));
    const { createApi } = createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: createPluginRuntimeMock({
        interSession: { send },
      }),
    });

    const api = createApi(createPluginRecord({ id: "voice-call" }), {
      config: {} as OpenClawConfig,
    });

    await expect(
      api.runtime.interSession.send({
        sessionKey: "agent:main:worker",
        message: "transport this",
      }),
    ).resolves.toEqual({
      messageRef: "voice-call",
    });
    expect(send).toHaveBeenCalledWith({
      sessionKey: "agent:main:worker",
      message: "transport this",
    });
  });
});
