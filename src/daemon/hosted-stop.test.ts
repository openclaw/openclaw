import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareHostedStopExecutor } from "./hosted-stop-executor.js";
import { prepareHostedGatewayStop, type GatewayProcessOwner } from "./hosted-stop.js";
import { probeLaunchAgentState } from "./launchd-runtime.js";
import { execSystemctl } from "./systemd-exec.js";
import { nativeExit } from "./systemd-exec.test-support.js";

vi.mock("node:fs/promises", () => ({ default: { readFile: vi.fn() } }));
vi.mock("./systemd-exec.js", () => ({ execSystemctl: vi.fn() }));
vi.mock("./hosted-stop-executor.js", () => ({ prepareHostedStopExecutor: vi.fn() }));
vi.mock("./launchd-runtime.js", () => ({
  probeLaunchAgentState: vi.fn(),
  resolveLaunchAgentGuiDomain: () => "gui/501",
}));

const noop = () => {};
const unit = "openclaw-test.service";
const systemctl = vi.mocked(execSystemctl);
const readFile = vi.mocked(fs.readFile);
const executor = vi.mocked(prepareHostedStopExecutor);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let cgroup = "/system.slice/openclaw-test.service";
const executorPid = 4321;
const execute = vi.fn<Awaited<ReturnType<typeof prepareHostedStopExecutor>>["execute"]>();
const dispose = vi.fn<() => Promise<void>>();
const processOwner: GatewayProcessOwner = { ownsProcessLifecycle: true, supervisor: "systemd" };
const identityResult = (fields: Record<string, string> = {}) =>
  nativeExit(
    Object.entries({
      Id: unit,
      LoadState: "loaded",
      ActiveState: "active",
      SubState: "running",
      MainPID: String(process.pid),
      ControlGroup: cgroup,
      InvocationID: "a".repeat(32),
      ExecMainStartTimestampMonotonic: "100",
      Job: "",
      CanStop: "yes",
      RefuseManualStop: "no",
      ...fields,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
const revoked = (message: string) => () => {
  throw new Error(message);
};
const prepare = (caller = noop, owner = processOwner, signal?: AbortSignal) =>
  prepareHostedGatewayStop(owner, caller, signal ?? new AbortController().signal);

beforeEach(() => {
  vi.resetAllMocks();
  dispose.mockResolvedValue(undefined);
  processOwner.supervisor = "systemd";
  cgroup = "/system.slice/openclaw-test.service";
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", undefined);
  vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.test");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  systemctl.mockImplementation(async () => identityResult());
  readFile.mockImplementation(async () => `0::${cgroup}\n`);
  executor.mockImplementation(async (params) => {
    const scope = params.scopeArgs?.find((arg) => arg.startsWith("--unit="))?.slice(7);
    readFile.mockImplementation(async (file) =>
      file === `/proc/${executorPid}/cgroup`
        ? `0::${cgroup.slice(0, cgroup.lastIndexOf("/"))}/${scope}\n`
        : `0::${cgroup}\n`,
    );
    await params.verifyPlacement?.(executorPid);
    return { execute, dispose };
  });
  execute.mockImplementation(async (assertCurrent) => {
    assertCurrent();
    return { disposition: "accepted", detail: "" };
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
});

it.each([
  { platformName: "linux", supervisor: null },
  { platformName: "win32", supervisor: "schtasks" },
] as const)(
  "exits only the owned process on $platformName with supervisor $supervisor",
  async ({ platformName, supervisor }) => {
    Object.defineProperty(process, "platform", { ...platform, value: platformName });
    const abort = new AbortController();
    const stop = await prepare(noop, { ownsProcessLifecycle: true, supervisor }, abort.signal);
    await expect(stop.execute(noop)).resolves.toEqual({ outcome: "exit" });
    await expect(stop.execute(revoked("retired host"))).rejects.toThrow("retired host");
    abort.abort();
    await expect(stop.execute(noop)).rejects.toThrow();
    await stop.dispose();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(probeLaunchAgentState).not.toHaveBeenCalled();
    expect(execSystemctl).not.toHaveBeenCalled();
    expect(prepareHostedStopExecutor).not.toHaveBeenCalled();
  },
);

async function expectScopeStop(scope: "--user" | "--system") {
  const stop = await prepare();
  expect(execute).not.toHaveBeenCalled();
  expect(prepareHostedStopExecutor).toHaveBeenCalledWith(
    expect.objectContaining({
      command: ["systemctl", scope, "--no-ask-password", "--no-block", "stop", unit],
      scopeArgs: expect.arrayContaining([scope, "--scope"]),
    }),
  );
  await expect(stop.execute(noop)).resolves.toEqual({ outcome: "accepted" });
  expect(execSystemctl).toHaveBeenCalled();
  expect(systemctl.mock.calls.every(([args]) => args[0] === scope)).toBe(true);
  await stop.dispose();
}

it.skipIf(typeof process.getuid !== "function")(
  "keeps a user service on its exact user manager",
  async () => {
    cgroup = `/user.slice/user-${process.getuid!()}.slice/user@${process.getuid!()}.service/app.slice/openclaw-test.service`;
    await expectScopeStop("--user");
  },
);

it.each([
  ["CanStop", "no"],
  ["RefuseManualStop", "yes"],
])("rejects %s=%s before acceptance and reports a late refusal", async (field, value) => {
  systemctl.mockResolvedValue(identityResult({ [field]: value }));
  await expect(prepare()).rejects.toThrow("does not permit manual stop");
  expect(prepareHostedStopExecutor).not.toHaveBeenCalled();
  systemctl.mockResolvedValue(identityResult());
  const stop = await prepare();
  systemctl.mockResolvedValue(identityResult({ [field]: value }));
  await expect(stop.execute(noop)).resolves.toMatchObject({ outcome: "refused" });
  expect(execute).not.toHaveBeenCalled();
  await stop.dispose();
});
it("acknowledges system stop only at execution", () => expectScopeStop("--system"));

it.each([
  ["Id", "other.service"],
  ["MainPID", "999999"],
  ["InvocationID", "b".repeat(32)],
  ["ExecMainStartTimestampMonotonic", "101"],
  ["Job", "23"],
  ["ControlGroup", "/system.slice/other.service"],
])("rejects changed %s during preparation before accepting stop", async (field, value) => {
  systemctl
    .mockResolvedValueOnce(identityResult())
    .mockResolvedValue(identityResult({ [field]: value }));
  await expect(prepare()).rejects.toThrow(/systemd|instance/);
  expect(execute).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
});

it.each(["cgroup", "unit", "executor"])(
  "rejects caller revocation during awaited %s discovery",
  async (discovery) => {
    const assertCaller = vi.fn();
    const revokeAfter =
      <T>(value: T) =>
      async () => {
        assertCaller.mockImplementation(revoked("closed caller"));
        return value;
      };
    if (discovery === "cgroup") {
      readFile.mockImplementationOnce(revokeAfter(`0::${cgroup}\n`));
    } else if (discovery === "unit") {
      systemctl.mockImplementationOnce(revokeAfter(identityResult()));
    } else {
      executor.mockImplementationOnce(revokeAfter({ execute, dispose }));
    }
    await expect(prepare(assertCaller)).rejects.toThrow("closed caller");
    expect(execute).not.toHaveBeenCalled();
    if (discovery === "executor") {
      expect(dispose).toHaveBeenCalledOnce();
    } else {
      expect(prepareHostedStopExecutor).not.toHaveBeenCalled();
    }
  },
);

it.each(["refused", "uncertain"] as const)(
  "classifies a %s result without manufacturing completion",
  async (disposition) => {
    const stop = await prepare();
    execute.mockResolvedValueOnce({ disposition, detail: "native fault" });
    await expect(stop.execute(noop)).resolves.toMatchObject({
      outcome: disposition,
      detail: expect.stringContaining("native fault"),
    });
    // Reopening requires a fresh native identity query after an explicit refusal.
    expect(execSystemctl).toHaveBeenCalledTimes(disposition === "refused" ? 4 : 3);
    await stop.dispose();
  },
);

it.each(["InvocationID", "ExecMainStartTimestampMonotonic", "caller"])(
  "does not execute after terminal %s revocation",
  async (field) => {
    const stop = await prepare();
    const assertCurrent = vi.fn();
    if (field === "caller") {
      systemctl.mockImplementationOnce(async () => {
        assertCurrent.mockImplementation(revoked("retired host"));
        return identityResult();
      });
    } else {
      systemctl.mockResolvedValue(
        identityResult({
          [field]: field === "InvocationID" ? "b".repeat(32) : "101",
        }),
      );
    }
    const result = await stop.execute(assertCurrent);
    if (field === "caller") {
      expect(result).toEqual({ outcome: "uncertain", detail: "retired host" });
    } else {
      expect(result).toMatchObject({ outcome: "uncertain" });
    }
    expect(execute).not.toHaveBeenCalled();
    await stop.dispose();
  },
);

it.each([true, false])("checks the exact macOS job before bootout (owned=%s)", async (owned) => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  processOwner.supervisor = "launchd";
  vi.mocked(probeLaunchAgentState).mockResolvedValue({
    state: "running",
    // Nested coalition state is not the job's canonical running state.
    runtime: { pid: owned ? process.pid : 999999, state: owned ? "active" : "running" },
  });
  if (!owned) {
    await expect(prepare()).rejects.toThrow("exact Gateway");
    expect(prepareHostedStopExecutor).not.toHaveBeenCalled();
    return;
  }
  const stop = await prepare();
  expect(prepareHostedStopExecutor).toHaveBeenCalledWith(
    expect.objectContaining({
      command: ["/bin/launchctl", "bootout", "gui/501/ai.openclaw.test"],
    }),
  );
  expect(execute).not.toHaveBeenCalled();
  await expect(stop.execute(noop)).resolves.toEqual({ outcome: "accepted" });
  await stop.dispose();
});

it.each([
  ["linux", "external", true],
  ["win32", "schtasks", false],
] as const)(
  "rejects unsupported %s/%s ownership",
  async (platformName, supervisor, ownsProcessLifecycle) => {
    Object.defineProperty(process, "platform", { ...platform, value: platformName });
    await expect(prepare(noop, { ownsProcessLifecycle, supervisor })).rejects.toThrow(
      /external supervisor|does not own the process lifecycle/,
    );
    expect(prepareHostedStopExecutor).not.toHaveBeenCalled();
  },
);
