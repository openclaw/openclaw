import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { reportPreMutationUpdateResult } from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const prompts = vi.hoisted(() => ({
  select: vi.fn<() => Promise<string>>(),
  confirm: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../../commands/configure.shared.js", () => prompts);

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("carries pre-mutation refusal facts through triage into the reviewed preview", async () => {
  const root = dirs.make("openclaw-update-report-handoff-");
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
  vi.stubEnv(POST_CORE_UPDATE_ENV, undefined);
  const output = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  prompts.select.mockReset().mockResolvedValueOnce("report").mockResolvedValue("dismiss");
  prompts.confirm.mockReset().mockResolvedValue(false);

  // Keep terminal failure construction, triage, report preparation and redaction
  // real. Direct renderer fixtures cannot catch a dropped upstream handoff.
  await withTriageTerminal(true, async () => {
    await expect(
      withUpdateFailureTriage({}, { root, env: { ...process.env } }, () =>
        reportPreMutationUpdateResult({
          root,
          installKind: "package",
          reason: "node-runtime-preflight",
          message: "Node at /private/customer-runtime cannot run the requested package.",
          errorDetails: {
            "Target package": "openclaw@2026.9.4",
            "Minimum Node engine": "26.0.0",
          },
          opts: {},
          controlPlaneUpdateSentinelMeta: null,
        }),
      ),
    ).rejects.toBeInstanceOf(ExitError);
  });

  const previews = output.mock.calls
    .map(([message]) => message)
    .filter(
      (message): message is string =>
        typeof message === "string" && message.startsWith("# OpenClaw update failure report\n"),
    );
  expect(previews).toHaveLength(1);
  expect(previews[0]).toContain("- Reason code: node-runtime-preflight\n");
  expect(previews[0]).toContain("- Target package: openclaw@2026.9.4\n");
  expect(previews[0]).toContain("- Minimum Node engine: 26.0.0\n");
  expect(previews[0]).not.toContain("customer-runtime");
  expect(prompts.confirm).toHaveBeenCalledOnce();
  expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
  expect(output).toHaveBeenCalledWith("Update failure report cancelled.");
});
