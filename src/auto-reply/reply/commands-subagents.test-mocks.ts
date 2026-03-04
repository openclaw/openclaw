import { vi } from "vitest";

export function installSubagentsCommandCoreMocks() {
  vi.mock("../../config/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../config/config.js")>();
    return {
      ...actual,
      loadConfig: () => ({}),
    };
  });

  // Prevent transitive import chain from reaching discord/monitor which needs https-proxy-agent.
  vi.mock("../../discord/monitor/gateway-plugin.js", () => ({
    createDiscordGatewayPlugin: () => ({}),
  }));
}
