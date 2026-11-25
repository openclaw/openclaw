import { describe, expect, it, vi } from "vitest";
import { recordCommandProcessFailure } from "../process/exec-result.js";
import {
  expectNoSideEffects,
  lastWriteJsonCall,
  packageInstallCommandCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const f = createUpdateCliFixture();

  it("checks original Git version before a dry-run package downgrade", async () => {
    mocks.readPackageVersion.mockResolvedValue("2026.9.3-beta.1");
    f.primeNpmChannelTag("latest", "2026.9.1");
    await update.updateCommand({ channel: "stable", json: true, dryRun: true });
    expect(lastWriteJsonCall()).toMatchObject({
      currentVersion: "2026.9.3-beta.1",
      targetVersion: "2026.9.1",
      downgradeRisk: true,
      switchToPackage: true,
    });
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(update.updateGitRelease, update.replaceConfigFile, mocks.spawn);
  });

  it("records diagnostics as a warning when the fresh plugin doctor cannot run", async () => {
    vi.mocked(update.resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      f.FRESH_POST_UPDATE_ENTRYPOINT,
    );
    vi.mocked(update.runUtf8CommandWithTimeout).mockRejectedValueOnce(
      recordCommandProcessFailure(
        Object.assign(new Error("Command failed: " + "long-argv-prefix ".repeat(100)), {
          stderr: "doctor process failed: optional plugin repair unavailable",
          stdout: "doctor diagnostic output",
        }),
        { code: 1, cleanup: "normal", termination: "exit" },
      ),
    );
    const result = await f.completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate).toMatchObject({
      status: "warning",
      reason: "post-plugin-doctor-execution-failed",
    });
    const message = result.pluginUpdate.warnings?.at(-1)?.message;
    expect(message).toMatch(/^[^\n]*update repair`[^]*process failed[^]*diagnostic output/u);
    expect(message).not.toContain("long-argv-prefix");
  });
});
