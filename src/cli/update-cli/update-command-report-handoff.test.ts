import { afterEach, expect, it, vi } from "vitest";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { UpdatePreMutationError } from "./shared.js";
import { handoffUpdateFromGateway } from "./update-command-handoff.js";
import { resolveMutableUpdateFailure, UpdateCommandFailure } from "./update-command-result.js";
import { reportPreMutationUpdateResult } from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const metadata = vi.hoisted(() => ({ unavailable: false }));
vi.mock("../../flows/doctor-health-contributions.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../flows/doctor-health-contributions.js")>();
  return {
    ...actual,
    resolveDoctorContributionHealthChecks: async () => {
      if (metadata.unavailable) {
        throw new Error("Installation metadata is unavailable after activation");
      }
      return actual.resolveDoctorContributionHealthChecks();
    },
  };
});

const prompts = vi.hoisted(() => ({
  select: vi.fn<() => Promise<string>>(),
  confirm: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("../../commands/configure.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/configure.shared.js")>()),
  ...prompts,
}));

let home: TempHomeEnv | undefined;
afterEach(async () => {
  metadata.unavailable = false;
  process.exitCode = undefined;
  closeOpenClawStateDatabaseForTest();
  await home?.restore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["runtime", "missing updater"] as const)(
  "carries %s facts through terminal failure and triage into the public preview",
  async (failure) => {
    home = await createTempHomeEnv("openclaw-update-report-handoff-");
    const root = home.home;
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
    vi.stubEnv(POST_CORE_UPDATE_ENV, undefined);
    const output = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    prompts.select.mockReset().mockResolvedValue("report");
    prompts.confirm.mockReset().mockResolvedValue(false);
    const message =
      failure === "runtime"
        ? "Target package: openclaw@2026.9.4; Minimum Node engine: 24.16.0; Running Node: 22.23.2"
        : "Cannot locate the installed updater; run `openclaw doctor` before retrying.";

    await withTriageTerminal(true, async () => {
      await expect(
        withUpdateFailureTriage({}, { root, env: { ...process.env } }, async () => {
          metadata.unavailable = true;
          if (failure === "missing updater") {
            mockProcessPlatform("linux");
            vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
            try {
              await handoffUpdateFromGateway({
                state: {
                  installed: true,
                  loadState: { status: "loaded" },
                  running: true,
                  command: null,
                  env: process.env,
                  runtime: { status: "running", pid: process.pid },
                },
                root,
                mode: "npm",
                opts: {},
                timeoutMs: 1000,
                stopProgress: () => {},
              });
            } catch (cause) {
              if (!(cause instanceof UpdatePreMutationError)) {
                throw cause;
              }
              throw new UpdateCommandFailure(
                (
                  await resolveMutableUpdateFailure({
                    root,
                    mode: "npm",
                    durationMs: 0,
                    cause,
                    originalRecovery: async () => undefined,
                  })
                ).result,
                1,
                cause.message,
              );
            }
            return;
          }
          await reportPreMutationUpdateResult({
            root,
            installKind: "package",
            reason: "node-runtime-preflight",
            message: "Node at /private/customer-runtime cannot run the requested package.",
            failureFacts: [
              {
                check: "node-runtime",
                code: "node-runtime-preflight",
                affectedKey: "engines.node",
                message,
              },
              {
                check: "core/doctor/runtime-tool-schemas",
                code: "doctor-failed",
                message: "ECONNREFUSED",
              },
            ],
            opts: {},
            controlPlaneUpdateSentinelMeta: null,
          });
        }),
      ).rejects.toBeInstanceOf(ExitError);
    });

    const previews = output.mock.calls
      .map(([value]) => value)
      .filter(
        (value): value is string =>
          typeof value === "string" && value.startsWith("# OpenClaw update failure report\n"),
      );
    expect(previews).toHaveLength(1);
    expect(previews[0]).toContain(message);
    if (failure === "runtime") {
      expect(previews[0]).toContain("Reason code: node-runtime-preflight");
      expect(previews[0]).toContain(
        "Failing check node-runtime (node-runtime-preflight); key engines.node",
      );
      expect(previews[0]).toContain("core/doctor/runtime-tool-schemas (doctor-failed)");
    } else {
      expect(previews[0]).toContain("Reason code: managed-service-handoff-failed");
      expect(previews[0]).not.toContain("[redacted-diagnostic]");
    }
    expect(previews[0]).not.toContain("customer-runtime");
    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(output).toHaveBeenCalledWith("Update failure report cancelled.");
  },
);
