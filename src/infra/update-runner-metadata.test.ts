import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as updateGlobal from "./update-global.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { runGatewayUpdate } from "./update-runner.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("explains a new Git checkout lacking target inspection before publication", async () => {
  const root = dirs.make("openclaw-preflight-metadata-");
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"1.0.0"}');
  await fs.writeFile(path.join(root, "openclaw.mjs"), "export {};\n");
  vi.spyOn(updateGlobal, "createGlobalInstallEnv").mockResolvedValue({});
  const runCommand = vi.fn(async (argv: string[]) => ({
    stdout: argv.includes("--show-toplevel")
      ? root
      : argv.includes("--abbrev-ref")
        ? "main"
        : argv.at(-1) === "HEAD"
          ? "abc123"
          : "",
    stderr: "",
    code: 0,
  }));
  const publishGitCheckout = vi.fn(async () => root);
  const beforeGitMutation = vi.fn<() => Promise<void>>();
  const result = await runGatewayUpdate({
    cwd: root,
    argv1: path.join(root, "openclaw.mjs"),
    channel: "dev",
    runCommand,
    timeoutMs: 5000,
    publishGitCheckout,
    beforeGitMutation,
  });
  expect(result).toMatchObject({
    status: "error",
    mode: "git",
    reason: "target-metadata-preflight",
  });
  expect(result.steps).toContainEqual(
    expect.objectContaining({
      name: "target-metadata-preflight",
      exitCode: 1,
      failureFacts: [
        expect.objectContaining({
          code: "target-git-inspection-missing",
          message: expect.stringContaining("openclaw update --channel dev"),
        }),
      ],
    }),
  );
  expect(renderUpdateRunReport(updateRunReportInputFromResult(result)).markdown).toContain(
    "openclaw update --channel dev",
  );
  expect(publishGitCheckout).not.toHaveBeenCalled();
  expect(beforeGitMutation).not.toHaveBeenCalled();
  expect(
    runCommand.mock.calls.some(([argv]) =>
      argv.some((arg) => ["fetch", "checkout", "reset", "rebase", "clean"].includes(arg)),
    ),
  ).toBe(false);
});
