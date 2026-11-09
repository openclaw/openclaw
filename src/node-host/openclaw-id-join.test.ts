import { beforeEach, expect, test, vi } from "vitest";
import { buildNodeJoinLink, fingerprint } from "../../packages/openclaw-id-protocol/src/index.js";
import { buildWorld } from "../../packages/openclaw-id-protocol/src/testing/world.js";
import { runNodeJoin } from "./openclaw-id-join.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  prepare: vi.fn(),
  enroll: vi.fn(),
  run: vi.fn(),
  install: vi.fn(),
  key: vi.fn(),
}));
// mock-isolation: join orchestration only; enrollment, runner, service and state owners have their own suites.
vi.mock("./config.js", () => ({ loadNodeHostConfig: mocks.load }));
// mock-isolation: the prepared manifest is an input here, not the behavior under test.
vi.mock("./runtime.js", () => ({ prepareNodeHostRuntime: mocks.prepare }));
// mock-isolation: the runner's connection and persistence are covered by runner.test.ts.
vi.mock("./runner.js", () => ({ runNodeHost: mocks.run }));
// mock-isolation: signed enrollment is covered against a real HTTP fixture in its own suite.
vi.mock("./openclaw-id-enrollment.js", () => ({ enrollNode: mocks.enroll }));
// mock-isolation: never read or create a real node key from this suite.
vi.mock("./openclaw-id-transport.js", () => ({ loadNodeTunnelKey: mocks.key }));
// mock-isolation: never install a real OS service from this suite.
vi.mock("../cli/node-cli/daemon.js", () => ({ runNodeDaemonInstall: mocks.install }));
// mock-isolation: keep the host's real OpenClaw config out of this suite.
vi.mock("../config/config.js", () => ({ captureRuntimeConfigAsyncReader: () => async () => ({}) }));
// mock-isolation: no real state database is opened.
vi.mock("./startup-state-readiness.js", () => ({ ensureNodeHostStateReady: vi.fn() }));
// mock-isolation: deterministic fallback display name.
vi.mock("../infra/machine-name.js", () => ({ getMachineDisplayName: async () => "machine" }));
const world = await buildWorld();
const target = {
  hostname: world.binding.body.hostname,
  pin: {
    claw_id: world.binding.body.claw_id,
    root_fp: await fingerprint(world.rootPub),
    binding_seq: 1,
  },
  evidence: { root_pub: world.rootPub, binding: world.binding },
  relayUrl: "https://relay.example/",
  discoveryUrl: "https://api.example",
};
const link = buildNodeJoinLink({
  invite_id: "12".repeat(16),
  secret: new Uint8Array(32).fill(42),
  claw_id: target.pin.claw_id,
  root_fp: target.pin.root_fp,
  hostname: target.hostname,
  relay_url: target.relayUrl,
});
const prepared = { manifest: { commands: ["system.run"], caps: ["system"] } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({
    gateway: { kind: "openclaw-id", openclawId: target },
    commands: ["system.run"],
  });
  mocks.prepare.mockResolvedValue(prepared);
  mocks.enroll.mockResolvedValue(target);
  mocks.run.mockResolvedValue({ connected: true });
  mocks.key.mockImplementation(() => Buffer.alloc(32, 7));
});

test("signs the actual selected surface, saves after verification, and shares preparation with first connect", async () => {
  await runNodeJoin(link, {
    displayName: "selected",
    commands: ["system.run"],
    discoveryUrl: "https://override.example/",
  });
  expect(mocks.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ commands: ["system.run"], enableAgentRuns: true }),
  );
  expect(mocks.enroll).toHaveBeenCalledWith(
    expect.objectContaining({
      discoveryUrl: "https://override.example",
      previousPin: target.pin,
      description: {
        display_name: "selected",
        platform: process.platform,
        commands: ["system.run"],
        caps: ["system"],
      },
    }),
  );
  expect(mocks.run.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.enroll.mock.invocationCallOrder[0]!,
  );
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({
      gatewayTarget: { kind: "openclaw-id", openclawId: target },
      preparedRuntime: prepared,
    }),
  );
  expect(mocks.install).not.toHaveBeenCalled();
});
test("--service connects once then installs the saved target with the selected commands", async () => {
  await runNodeJoin(link, { service: true, allCommands: true });
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ commands: undefined }));
  expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ stopAfterFirstConnect: true }));
  expect(mocks.install).toHaveBeenCalledWith(
    expect.objectContaining({ force: true, allCommands: true }),
  );
  expect(mocks.install.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.run.mock.invocationCallOrder[0]!,
  );
});
test("failed admission preserves the saved endpoint and never installs", async () => {
  mocks.enroll.mockRejectedValueOnce(new Error("Possible claw substitution"));
  await expect(runNodeJoin(link, { service: true })).rejects.toThrow("substitution");
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
});
test("missing Discovery configuration fails before key creation or mail", async () => {
  mocks.load.mockResolvedValueOnce(null);
  await expect(runNodeJoin(link, {})).rejects.toThrow("--discovery-url");
  expect(mocks.key).not.toHaveBeenCalled();
  expect(mocks.enroll).not.toHaveBeenCalled();
});

test("does not install after a runner exits without a successful first hello", async () => {
  mocks.run.mockResolvedValueOnce(undefined);
  await expect(runNodeJoin(link, { service: true })).rejects.toThrow("service was not installed");
  expect(mocks.install).not.toHaveBeenCalled();
});
