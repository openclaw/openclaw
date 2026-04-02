import { beforeEach, describe, expect, it } from "vitest";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  buildPluginStatusReport,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeLogs,
} from "./plugins-cli-test-helpers.js";

describe("plugins cli list", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("includes imported state in JSON output", async () => {
    buildPluginStatusReport.mockReturnValue({
      workspaceDir: "/workspace",
      plugins: [
        createPluginRecord({
          id: "demo",
          imported: true,
          activated: true,
          explicitlyEnabled: true,
        }),
      ],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "list", "--json"]);

    expect(buildPluginStatusReport).toHaveBeenCalledWith({ loadModules: false });

    expect(JSON.parse(runtimeLogs[0] ?? "null")).toEqual({
      workspaceDir: "/workspace",
      plugins: [
        expect.objectContaining({
          id: "demo",
          imported: true,
          activated: true,
          explicitlyEnabled: true,
        }),
      ],
      diagnostics: [],
    });
  });

  it("shows imported state in verbose output", async () => {
    buildPluginStatusReport.mockReturnValue({
      plugins: [
        createPluginRecord({
          id: "demo",
          name: "Demo Plugin",
          imported: false,
          activated: true,
          explicitlyEnabled: false,
        }),
      ],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "list", "--verbose"]);

    expect(buildPluginStatusReport).toHaveBeenCalledWith({ loadModules: false });

    const output = runtimeLogs.join("\n");
    expect(output).toContain("activated: yes");
    expect(output).toContain("imported: no");
    expect(output).toContain("explicitly enabled: no");
  });
});
