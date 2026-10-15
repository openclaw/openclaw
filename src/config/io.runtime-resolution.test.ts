// Verifies directory resolution keeps a rejected config's reason in its warning.
import { describe, expect, it, vi } from "vitest";
import { readCurrentConfigForResolution } from "./io.runtime.js";
import { loggedConfigWarningFingerprints } from "./io.state.js";
import { withTempHomeConfig } from "./test-helpers.js";

async function captureResolutionWarning(params: {
  config: unknown;
  missingFile?: boolean;
}): Promise<{ warning: string; diagnosticMessage: string | undefined }> {
  return await withTempHomeConfig(params.config, async ({ configPath }) => {
    loggedConfigWarningFingerprints.clear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const resolution = readCurrentConfigForResolution({
        configPath: params.missingFile ? `${configPath}.missing` : configPath,
      });
      return {
        warning: String(warn.mock.calls[0]?.[0] ?? ""),
        diagnosticMessage: resolution.configDiagnostics?.issues[0]?.message,
      };
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
}

describe("readCurrentConfigForResolution", () => {
  it("names the rejection that made a present config unavailable", async () => {
    const captured = await captureResolutionWarning({
      config: { skills: { workshop: { approvalPolicy: "pending", maxPending: 3 } } },
    });

    expect(captured.warning).toContain("Config unavailable");
    expect(captured.warning).toContain("skills.workshop");
    expect(captured.warning).toContain("Unrecognized keys");
    expect(captured.diagnosticMessage).toContain("Unrecognized keys");
    expect(captured.warning).not.toContain("\n");
  });

  it("keeps the plain unavailable warning when the config file is missing", async () => {
    const captured = await captureResolutionWarning({ config: {}, missingFile: true });

    expect(captured.warning).toContain(
      "Config unavailable; using environment and default agent directory settings.",
    );
  });
});
