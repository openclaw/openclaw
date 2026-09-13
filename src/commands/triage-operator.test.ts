import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveInstallationTarget } from "../infra/installation-target-context.js";
import { runOperatorTriage } from "./triage-operator.js";
import { createTriageRuntime } from "./triage.test-support.js";

const mocks = vi.hoisted(() => ({
  root: vi.fn(),
  continuation: vi.fn(),
  settle: vi.fn(),
  writeFailure: vi.fn(),
}));
vi.mock("../infra/openclaw-root.js", () => ({ resolveOpenClawPackageRoot: mocks.root }));
vi.mock("../infra/triage-continuation.js", () => ({
  resolveTriageEntrypoint: async () => [process.execPath, "fixture-openclaw"],
  continueTriageInFreshProcess: mocks.continuation,
}));
vi.mock("./triage-task-result.js", () => ({ settleTriageRepairTask: mocks.settle }));
vi.mock("./triage-update.js", async (original) => ({
  ...(await original<typeof import("./triage-update.js")>()),
  writeTriageUpdateFailure: mocks.writeFailure,
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);

const validation = { ok: false, score: -1, summary: "Doctor lint found an error." };
describe("original operator parent result", () => {
  let root: string;
  beforeEach(() => {
    vi.clearAllMocks();
    root = dirs.make("operator-parent-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    mocks.root.mockResolvedValue(root);
  });
  afterEach(() => vi.unstubAllEnvs());

  function completed(repair: unknown) {
    return {
      status: "completed",
      installationRoot: root,
      generationOwner: "fixture-generation",
      commandOutput: {
        kind: "complete",
        stdout: JSON.stringify({ installationRoot: root, repair }),
      },
    };
  }
  function run(
    runtime: ReturnType<typeof createTriageRuntime>,
    json = false,
    isCurrent?: () => boolean,
  ) {
    return runOperatorTriage({
      runtime,
      target: resolveInstallationTarget(),
      json,
      noExport: true,
      isCurrent,
    });
  }

  it.each([
    { status: "improved", reason: "turn-budget", code: 1 },
    { status: "unrepaired", reason: "Validation regressed after repair.", code: 1 },
    { status: "aborted", reason: "cancelled", code: 1 },
    { status: "unrepaired", reason: "per-turn-budget", code: 2 },
    { status: "improved", reason: "wall-clock-budget", code: 2 },
  ])("maps joined $status/$reason to exit $code", async ({ status, reason, code }) => {
    const repair = { status, reason, attempts: [], finalValidation: validation };
    mocks.continuation.mockResolvedValue(completed(repair));
    const runtime = createTriageRuntime();
    await expect(run(runtime, true)).rejects.toMatchObject({ code });
    expect(runtime.writeJson).toHaveBeenCalledWith({ installationRoot: root, repair }, 2);
    expect(mocks.continuation).toHaveBeenCalledWith(
      expect.objectContaining({
        operator: { kind: "operator", installationRoot: root, gateway: "preserve" },
      }),
    );
  });

  it("admits bounded in-memory failure when the optional support export is unwritable", async () => {
    mocks.writeFailure.mockRejectedValueOnce(new Error("EACCES: support export unavailable"));
    const failure = { error: "Original captured failure" };
    mocks.continuation.mockResolvedValue(
      completed({
        status: "repaired",
        attempts: [],
        finalValidation: { ...validation, ok: true, score: 0 },
      }),
    );
    const runtime = createTriageRuntime();
    await runOperatorTriage({
      runtime,
      target: resolveInstallationTarget(),
      json: true,
      noExport: true,
      updateFailure: failure,
    });
    expect(mocks.continuation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operator: {
          kind: "operator",
          installationRoot: root,
          gateway: "preserve",
          updateFailure: failure,
        },
        commandArgv: [
          process.execPath,
          "fixture-openclaw",
          "--run",
          "--json",
          "--non-interactive",
          "--no-export",
        ],
      }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("explains a redacted transport failure in terminal output", async () => {
    mocks.continuation.mockRejectedValue(new Error("Installed child could not start"));
    const runtime = createTriageRuntime();
    await expect(run(runtime)).rejects.toMatchObject({ code: 1 });
    expect(runtime.log).toHaveBeenCalledWith("Repair unavailable: Installed child could not start");
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it("accepts independently validated repair without claiming Gateway activation", async () => {
    mocks.continuation.mockResolvedValue(
      completed({
        status: "repaired",
        attempts: [],
        finalValidation: { ...validation, ok: true, score: 0 },
      }),
    );
    const runtime = createTriageRuntime();
    await run(runtime);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Repair checks passed. Gateway activation is reported separately.",
    );
  });

  it.each([
    { reason: "The configured model is unavailable", hint: "Run `openclaw onboard`" },
    { reason: "exec-denied-by-policy", hint: "Use `openclaw triage` for an external handoff." },
  ])("explains unavailable repair: $reason", async ({ reason, hint }) => {
    mocks.continuation.mockResolvedValue(
      completed({ status: "unavailable", reason, attempts: [], finalValidation: validation }),
    );
    const runtime = createTriageRuntime();
    await expect(run(runtime)).rejects.toMatchObject({ code: 1 });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(reason));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(hint));
  });

  it("rejects success without validation before task projection", async () => {
    mocks.continuation.mockResolvedValue(
      completed({ status: "repaired", attempts: [], finalValidation: validation }),
    );
    const runtime = createTriageRuntime();
    await expect(run(runtime, true)).rejects.toMatchObject({ code: 1 });
    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ repair: expect.objectContaining({ status: "unavailable" }) }),
      2,
    );
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it("does not publish or exit after the original owner closes during the join", async () => {
    let current = true;
    mocks.continuation.mockImplementation(async () => {
      current = false;
      return completed({ status: "unrepaired", attempts: [], finalValidation: validation });
    });
    const runtime = createTriageRuntime();
    await run(runtime, true, () => current);
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
