import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { encodePairingSetupCode } from "../../pairing/setup-code.js";
import { registerNodeCli } from "./register.js";

const pairPin = "ab".repeat(32),
  explicitPin = "cd".repeat(32),
  savedPin = "ef".repeat(32);
type LoadNodeHostConfig = typeof import("../../node-host/config.js").loadNodeHostConfig;
const mocks = vi.hoisted(() => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  loadNodeHostConfig: vi.fn<LoadNodeHostConfig>(async () => null),
  runNodeHost: vi.fn(),
  runNodeHostWorker: vi.fn(),
  runNodeDaemonInstall: vi.fn(),
  runNodeDaemonLifecycle: vi.fn(),
  runNodeDaemonStatus: vi.fn(),
}));
// mock-isolation: Command dispatch must not install or alter host services.
vi.mock("./daemon.js", () => mocks);
// mock-isolation: Saved configuration is an explicit per-case fixture, never the operator's file.
vi.mock("../../node-host/config.js", () => ({ loadNodeHostConfig: mocks.loadNodeHostConfig }));
// mock-isolation: Assert dispatch without starting a real node host.
vi.mock("../../node-host/runner.js", () => ({ runNodeHost: mocks.runNodeHost }));
// mock-isolation: Assert worker options without starting a real worker.
vi.mock("../../node-host/worker.js", () => ({ runNodeHostWorker: mocks.runNodeHostWorker }));
// mock-isolation: Capture command output and exits without affecting the test process.
vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));
const { defaultRuntime: runtime } = mocks;

// Split only fixed command text; literal trailing arguments preserve blank values and setup codes.
function run(args: string, ...tail: string[]) {
  const quiet = () => undefined;
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: quiet, writeOut: quiet });
  registerNodeCli(program);
  return program.parseAsync(["node", ...args.split(" "), ...tail], { from: "user" });
}
const expectHost = (expected: Record<string, unknown>) =>
  expect(mocks.runNodeHost).toHaveBeenCalledWith(expect.objectContaining(expected));
const pairingPayload = {
  url: "wss://paired.example:8443",
  bootstrapToken: "bootstrap-123",
  tlsFingerprint: `sha256:${pairPin.toUpperCase()}`,
};
const expiredCode = encodePairingSetupCode({ ...pairingPayload, expiresAtMs: 1 });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadNodeHostConfig.mockResolvedValue(null);
});

it.each([
  ["worker --desktop-sharing", mocks.runNodeHostWorker, [{ desktopSharingEnabled: true }]],
  ["status --json", mocks.runNodeDaemonStatus, [{ json: true }]],
  ["uninstall --json", mocks.runNodeDaemonLifecycle, ["uninstall", { json: true }]],
] as const)("forwards node %s", async (args, target, expected) => {
  await run(args);
  expect(target).toHaveBeenCalledWith(...expected);
});

it.each([
  "--commands fixture.read,fixture.list install",
  "install --commands fixture.read --commands fixture.list,fixture.read",
])("accepts exact command allowlists: %s", async (args) => {
  await run(args);
  expect(mocks.runNodeDaemonInstall).toHaveBeenLastCalledWith(
    expect.objectContaining({ commands: ["fixture.list", "fixture.read"] }),
  );
});

it("rejects empty command ids instead of silently widening the surface", async () => {
  await expect(run("run --commands fixture.list,")).rejects.toThrow("non-empty command ids");
  expect(mocks.runNodeHost).not.toHaveBeenCalled();
});

it.each([
  "run --all-commands --commands fixture.read",
  "--all-commands run --commands fixture.read",
  "--commands fixture.read run --all-commands",
  "--commands fixture.read --all-commands run",
])("rejects conflicting command selections: %s", async (args) => {
  await expect(run(args)).rejects.toThrow(/--all-commands.*--commands/);
  expect(mocks.runNodeHost).not.toHaveBeenCalled();
  expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  expect(mocks.loadNodeHostConfig).not.toHaveBeenCalled();
});

it("hosts worker turns only on request: --ephemeral", async () => {
  const program = await run("run --ephemeral");
  expectHost({ forceWorkerRuns: true, ephemeral: true });
  const node = program.commands.find((command) => command.name() === "node");
  expect(
    node?.commands.find((command) => command.name() === "run")?.helpInformation(),
  ).not.toContain("--ephemeral");
});

it("allows expired fallback pairing without preferring its token", async () => {
  await run("run --pair-if-needed", expiredCode);
  expect(runtime.error).not.toHaveBeenCalled();
  expectHost({
    gatewayHost: "paired.example",
    gatewayBootstrapToken: "bootstrap-123",
    gatewayBootstrapExpiresAtMs: 1,
    preferGatewayBootstrapToken: false,
  });
});

it("lets explicit gateway flags override --pair values", async () => {
  const code = encodePairingSetupCode(pairingPayload);
  await run(
    `run --host explicit.example --port 19000 --tls-fingerprint sha256:${explicitPin} --pair`,
    code,
  );
  expectHost({
    gatewayHost: "explicit.example",
    gatewayPort: 19000,
    gatewayTls: true,
    gatewayTlsFingerprint: explicitPin,
    gatewayCandidates: undefined,
    gatewayBootstrapToken: "bootstrap-123",
    preferGatewayBootstrapToken: true,
  });
});

it.each([
  [["--port", "abc"], expect.stringContaining("Invalid --port")],
  [
    ["--no-tls", "--tls-fingerprint", pairPin],
    "--no-tls cannot be combined with --tls-fingerprint",
  ],
  [["--tls-fingerprint", "sha256:abc123"], expect.stringContaining("Invalid TLS fingerprint")],
  [["--pair", expiredCode], "Pairing setup code has expired."],
] as const)("rejects invalid connection flags %j before starting the host", async (args, error) => {
  await run("run", ...args);
  expect(mocks.runNodeHost).not.toHaveBeenCalled();
  expect(runtime.error).toHaveBeenCalledWith(error);
  expect(runtime.exit).toHaveBeenCalledWith(1);
});

it.each([
  { args: ["--port", "19001"], changed: false, plaintext: false },
  { args: ["--tls-fingerprint", ""], changed: false, plaintext: false },
  { args: ["--tls-fingerprint", "   "], changed: false, plaintext: false },
  { args: ["--port", "19002"], changed: true, plaintext: false },
  { args: ["--no-tls"], changed: false, plaintext: true },
])("inherits saved TLS only for its endpoint: $args", async ({ args, changed, plaintext }) => {
  mocks.loadNodeHostConfig.mockResolvedValue({
    version: 1,
    nodeId: "node-existing",
    gateway: {
      host: "10.0.0.2",
      port: 19001,
      tls: true,
      tlsFingerprint: savedPin,
      contextPath: "/saved",
    },
  });
  await run("run", ...args);
  expectHost({
    gatewayTls: plaintext ? false : changed ? undefined : true,
    gatewayTlsFingerprint: changed || plaintext ? undefined : savedPin,
    gatewayContextPath: changed ? undefined : "/saved",
    ...(!changed ? { gatewayHost: "10.0.0.2", gatewayPort: 19001 } : {}),
  });
});
