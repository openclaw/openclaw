import { afterEach, expect, it, vi } from "vitest";
import type { LaneState } from "../../scripts/lib/cross-os-release-checks/config.ts";

const mocks = vi.hoisted(() => ({
  runInstalledCli: vi.fn(),
  runOpenClaw: vi.fn(),
}));

vi.mock("../../scripts/lib/cross-os-release-checks/installed.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/installed.ts")
  >()),
  runInstalledCli: mocks.runInstalledCli,
}));

vi.mock("../../scripts/lib/cross-os-release-checks/runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/runtime.ts")
  >()),
  runOpenClaw: mocks.runOpenClaw,
}));

import { installLaneCompanions } from "../../scripts/lib/cross-os-release-checks/lane-companions.ts";

const lane: LaneState = {
  name: "fresh",
  rootDir: "/tmp/openclaw-release",
  prefixDir: "/tmp/openclaw-release/prefix",
  homeDir: "/tmp/openclaw-release/home",
  stateDir: "/tmp/openclaw-release/state",
  appDataDir: "/tmp/openclaw-release/app-data",
  gatewayPort: 18789,
  phaseTimings: [],
};
const companions = [
  { name: "@openclaw/codex", tarballPath: "/tmp/openclaw-codex.tgz" },
  { name: "@openclaw/discord", tarballPath: "/tmp/openclaw-discord.tgz" },
];
const env = { HOME: lane.homeDir };
const installArgs = ["plugins", "install"];
const success = { exitCode: 0, stdout: "", stderr: "" };
function install(cliPath?: string) {
  return installLaneCompanions({
    companions,
    logsDir: "/tmp/openclaw-release/logs",
    lane: { ...lane, phaseTimings: [] },
    env,
    ...(cliPath ? { cliPath } : {}),
  });
}

afterEach(() => vi.resetAllMocks());

it.each([
  { cliPath: undefined, runner: "packaged", supported: true },
  { cliPath: "/tmp/openclaw", runner: "installed", supported: false },
] as const)("probes capability consent once via $runner", async ({ cliPath, supported }) => {
  const runner = cliPath ? mocks.runInstalledCli : mocks.runOpenClaw;
  runner
    .mockResolvedValueOnce({
      ...success,
      stdout: supported ? "  --accept-capabilities  Accept declared capabilities\n" : "Usage\n",
    })
    .mockResolvedValue(success);

  await install(cliPath);
  const consent = supported ? ["--accept-capabilities"] : [];
  const expectedArgs = [
    [...installArgs, "--help"],
    ...companions.map(({ tarballPath }) =>
      installArgs.concat(`npm-pack:${tarballPath}`, "--force", consent),
    ),
  ];
  expect(runner.mock.calls).toEqual(
    expectedArgs.map((args) => [expect.objectContaining({ args, env })]),
  );
  expect(cliPath ? mocks.runOpenClaw : mocks.runInstalledCli).not.toHaveBeenCalled();
});

it("fails the lane when the help probe fails", async () => {
  mocks.runOpenClaw.mockRejectedValueOnce(new Error("help probe failed"));
  await expect(install()).rejects.toThrow("help probe failed");
  expect(mocks.runOpenClaw).toHaveBeenCalledTimes(1);
});
