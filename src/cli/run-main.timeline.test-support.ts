import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, type Mock } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { withEnvAsync } from "../test-utils/env.js";

export function registerRunMainTimelineTests({
  runCli,
  loadConfigMock,
  readSourceConfigBestEffortMock,
  tryRouteCliMock,
}: {
  runCli: (argv: string[]) => Promise<void>;
  loadConfigMock: Mock;
  readSourceConfigBestEffortMock: Mock;
  tryRouteCliMock: Mock;
}): void {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it.each([
    ["node", "worker"],
    ["node", "run"],
    ["gateway", "run"],
  ])(
    "preserves %s %s config ownership when startup tracing is enabled",
    async (command, subcommand) => {
      const root = tempDirs.make("openclaw-node-timeline-");
      const timelinePath = path.join(root, "timeline.jsonl");
      if (command === "node") {
        tryRouteCliMock.mockResolvedValueOnce(true);
      }
      const readTimelineConfig =
        command === "gateway" ? loadConfigMock : readSourceConfigBestEffortMock;
      readTimelineConfig.mockResolvedValueOnce({
        diagnostics: { flags: ["timeline"] },
      });
      try {
        await withEnvAsync(
          { OPENCLAW_DIAGNOSTICS: "", OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath },
          async () => {
            await runCli(["node", "openclaw", command, subcommand]);
          },
        );
        if (command === "gateway") {
          expect(loadConfigMock).toHaveBeenCalledWith({
            observe: false,
            isolateEnv: true,
            pluginValidation: "core-only",
          });
          expect(readSourceConfigBestEffortMock).not.toHaveBeenCalled();
        } else if (subcommand === "run") {
          expect(loadConfigMock).toHaveBeenCalledWith({
            observe: false,
            skipPluginValidation: true,
          });
        } else {
          expect(loadConfigMock).not.toHaveBeenCalled();
        }
        flushDiagnosticsTimeline();
        expect(await fs.readFile(timelinePath, "utf8")).toContain("cli.main.argv");
      } finally {
        flushDiagnosticsTimeline();
      }
    },
  );
}
