import { expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { runDaemonInstall } from "../daemon-cli/install.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";

// A missing target must never select the updater's old native/config writer.
vi.mock("../daemon-cli/install.js", () => ({ runDaemonInstall: vi.fn() }));

it.each(["git", "unknown"] as const)(
  "refuses a missing %s target without installing through the old runtime",
  async (mode) => {
    vi.mocked(runDaemonInstall).mockClear();
    await withTestDir({ prefix: "openclaw-native-missing-target-" }, async (root) => {
      await expect(
        runUpdatedInstallGatewayCommand(
          {
            result: { root, mode },
            opts: { json: true },
            invocationEnv: {},
          },
          "install",
        ),
      ).rejects.toThrow("updated install entrypoint not found");
      expect(runDaemonInstall).not.toHaveBeenCalled();
    });
  },
);
