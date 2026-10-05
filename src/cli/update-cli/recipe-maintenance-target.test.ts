import { beforeEach, expect, it, vi } from "vitest";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { runUpgradeRecipeTargetMaintenance } from "./recipe-maintenance-target.js";
import { approvedContext } from "./update-recipe-context.test-support.js";
import { UPDATE_RECIPE_MAINTENANCE_CAPABILITY } from "./update-recipe-maintenance-contract.js";

const fixture = vi.hoisted(() => ({ command: vi.fn(), bind: vi.fn(), inspector: vi.fn() }));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout: fixture.command,
}));
vi.mock("./update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-executor.js")>()),
  captureUpdateCommandExecutorAuthority: () => ({ installKey: "/target" }),
  withUpdateCommandExecutorChild: async (
    _fence: unknown,
    _root: string,
    run: (grant: unknown, bind: unknown) => unknown,
  ) => run({ runId: "run", root: "/target" }, fixture.bind),
}));
// mock-isolation: policy admission is tested at its owner, not through a native runner here.
vi.mock("./recipe-qualification.js", async (original) => ({
  ...(await original<typeof import("./recipe-qualification.js")>()),
  admitReleaseQualificationChildInspector: fixture.inspector,
}));
function commandCall(index: number) {
  const call = fixture.command.mock.calls[index];
  if (!call) {
    throw new Error(`Expected command call ${index} was not observed`);
  }
  return call;
}
const binding = {
  protocol: 1 as const,
  runId: "run",
  planDigest: "a".repeat(64),
  targetArtifactId: "target-artifact",
  installationKey: "/target",
  stateRootKey: "/state",
};
const receipt = { binding, phase: "committed", revision: 3, updatedAtMs: 1 };
const options = () => ({
  recipe: {
    ...approvedContext(),
    maintenance: { ...approvedContext().maintenance, binding },
  },
  fence: { assertCurrent: vi.fn() },
  input: {
    binding,
    expected: {
      version: "fixture",
      buildId: "fixture-build",
      runtimeExecutable: "/runtime/node",
      installationRoot: "/target",
      stateRoot: "/state",
      configPath: "/state/openclaw.json",
      configHash: "b".repeat(64),
      configSourceDigest: "c".repeat(64),
      profile: "default",
    },
    stateVersions: [{ path: "/state/state/openclaw.sqlite", userVersion: 1 }],
    port: 18789,
    timeoutMs: 1000,
  },
  env: { OPENCLAW_STATE_DIR: "/state" },
  verifyTarget: vi.fn(async () => {}),
});
beforeEach(() => {
  fixture.inspector.mockReset().mockResolvedValue(undefined);
  fixture.command.mockReset();
  fixture.bind.mockReset();
  fixture.command.mockImplementation(
    async (argv: string[], input: { beforeInput: (pid: number, argv: string[]) => void }) => {
      input.beforeInput(42, argv);
      return {
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        stderr: "",
        stdout: JSON.stringify(
          argv.at(-1) === "--check"
            ? { capability: UPDATE_RECIPE_MAINTENANCE_CAPABILITY }
            : {
                capability: UPDATE_RECIPE_MAINTENANCE_CAPABILITY,
                outcome: "target-committed",
                managedServiceVerified: false,
                receipt,
              },
        ),
      };
    },
  );
});

it.each(["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "OPENSSL_CONF"])(
  "refuses %s code injection before executing even the capability probe",
  async (selector) => {
    const selected = options();
    await expect(
      runUpgradeRecipeTargetMaintenance({
        ...selected,
        env: { ...selected.env, [selector]: "untrusted" },
      }),
    ).rejects.toThrow("injection");
    expect(fixture.command).not.toHaveBeenCalled();
    expect(selected.verifyTarget).not.toHaveBeenCalled();
  },
);

it("binds both target children, rehashes before effects, and leaves manager verification explicit", async () => {
  const selected = options();
  const result = await runUpgradeRecipeTargetMaintenance(selected);
  expect(selected.verifyTarget).toHaveBeenCalledTimes(2);
  expect(fixture.bind).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    outcome: "target-committed",
    managedServiceVerified: false,
    receipt,
  });
  expect(fixture.command.mock.calls[1]?.[1]).toMatchObject({
    baseEnv: {},
    killProcessTree: true,
    requireProcessTreeExtinction: true,
  });
  const payload = JSON.parse(fixture.command.mock.calls[1]?.[1].input);
  expect(payload.binding).toEqual(binding);
  expect(payload.executor).toEqual({ runId: "run", root: "/target" });
});

it("does not accept a different plan's committed receipt or replay the target", async () => {
  fixture.command.mockResolvedValueOnce({
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    stdout: JSON.stringify({ capability: UPDATE_RECIPE_MAINTENANCE_CAPABILITY }),
  });
  fixture.command.mockResolvedValueOnce({
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    stdout: JSON.stringify({
      capability: UPDATE_RECIPE_MAINTENANCE_CAPABILITY,
      outcome: "target-committed",
      managedServiceVerified: false,
      receipt: { ...receipt, binding: { ...binding, planDigest: "f".repeat(64) } },
    }),
  });
  await expect(runUpgradeRecipeTargetMaintenance(options())).rejects.toThrow("exact approved run");
  expect(fixture.command).toHaveBeenCalledTimes(2);
});

it("propagates unconfirmed target cleanup even when the transport exited", async () => {
  fixture.command.mockResolvedValueOnce({
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    stdout: JSON.stringify({ capability: UPDATE_RECIPE_MAINTENANCE_CAPABILITY }),
  });
  fixture.command.mockResolvedValueOnce({
    code: 1,
    signal: null,
    killed: false,
    termination: "exit",
    stdout: JSON.stringify({ processSettlement: "uncertain" }),
  });
  const failure = await runUpgradeRecipeTargetMaintenance(options()).catch(
    (error: unknown) => error,
  );
  expect(hasCommandProcessCleanupError(failure)).toBe(true);
});

it("pauses only the admitted maintenance run, preserving both exact child bindings", async () => {
  fixture.inspector.mockResolvedValue("--inspect-brk=127.0.0.1:0");
  const selected = options();
  await runUpgradeRecipeTargetMaintenance(selected);
  expect(fixture.inspector).toHaveBeenCalledWith(selected.recipe, selected.fence);
  expect(fixture.command.mock.calls[0]?.[0]).toEqual([
    "/runtime/node",
    expect.stringContaining("dist/"),
    "--check",
  ]);
  expect(fixture.command.mock.calls[1]?.[0]).toEqual([
    "/runtime/node",
    "--inspect-brk=127.0.0.1:0",
    expect.stringContaining("dist/"),
    "--run",
  ]);
  expect(commandCall(0)[1].onOutputChunk).toBeUndefined();
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const observe = commandCall(1)[1].onOutputChunk;
    const announcement = Buffer.from("Debugger listening on ws://127.0.0.1:43123/fixture\n");
    observe(announcement, "stderr");
    observe(Buffer.from("result"), "stdout");
    expect(write).toHaveBeenCalledExactlyOnceWith(announcement);
  } finally {
    write.mockRestore();
  }
  for (const [argv] of fixture.command.mock.calls) {
    expect(fixture.bind).toHaveBeenCalledWith(42, argv);
  }
});
it.each(["custody revoked", "catalog expired", "executor changed"])(
  "does not launch maintenance effects when admission reports %s",
  async (reason) => {
    fixture.inspector.mockRejectedValue(new Error(reason));
    await expect(runUpgradeRecipeTargetMaintenance(options())).rejects.toThrow(reason);
    expect(fixture.command).toHaveBeenCalledTimes(1);
    expect(fixture.command.mock.calls[0]?.[0].at(-1)).toBe("--check");
  },
);
