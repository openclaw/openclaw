import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyPluginInstallConfigPatch } from "./plugins-cli.js";

describe("applyPluginInstallConfigPatch", () => {
  it("deep-merges manifest configPatch into the install config", () => {
    const config = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
      tools: {
        alsoAllow: ["existing"],
      },
    } as OpenClawConfig;

    const next = applyPluginInstallConfigPatch(config, {
      providers: {
        demo: {
          apiKey: "test-key",
        },
      },
      tools: {
        alsoAllow: ["plugin-tool"],
      },
    });

    expect(next.plugins?.entries?.demo?.enabled).toBe(true);
    expect(next.providers).toEqual({
      demo: {
        apiKey: "test-key",
      },
    });
    expect(next.tools?.alsoAllow).toEqual(["plugin-tool"]);
  });
});
