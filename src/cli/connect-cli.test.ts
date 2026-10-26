import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import type { NodeHostConfig, NodeHostGatewayConfig } from "../node-host/config.js";
import { encodePairingSetupCode } from "../pairing/setup-code.js";
import { registerConnectCli } from "./connect-cli.js";

const mocks = vi.hoisted(() => ({
  runNodeHost: vi.fn(),
  loadResumableNodeHostGateway: vi.fn<() => Promise<NodeHostGatewayConfig | undefined>>(
    async () => undefined,
  ),
  runNodeDaemonInstall: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
  loadNodeHostConfig: vi.fn<() => Promise<NodeHostConfig | null>>(async () => null),
  mutateConfigFileWithRetry: vi.fn(),
  runtime: {
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../node-host/runner.js", () => ({
  loadResumableNodeHostGateway: mocks.loadResumableNodeHostGateway,
  runNodeHost: mocks.runNodeHost,
}));
vi.mock("../node-host/config.js", () => ({ loadNodeHostConfig: mocks.loadNodeHostConfig }));
// mock-isolation: Connect fixtures capture config mutations without reading or writing operator state.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  loadConfig: vi.fn(() => ({})),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
  mutateConfigFileWithRetry: mocks.mutateConfigFileWithRetry,
}));
vi.mock("./node-cli/daemon.js", () => ({
  runNodeDaemonInstall: mocks.runNodeDaemonInstall,
}));
vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  mocks.fetchWithSsrFGuard.mockImplementation(actual.fetchWithSsrFGuard);
  return { fetchWithSsrFGuard: mocks.fetchWithSsrFGuard };
});
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.runtime }));

const payload = {
  url: "wss://192.168.1.20:8443/openclaw-gw",
  urls: ["wss://192.168.1.20:8443/openclaw-gw", "wss://gateway.tailnet.example/tailnet-gw"],
  bootstrapToken: "bootstrap-token",
  tlsFingerprint: "ab".repeat(32),
};

function setupCode(): string {
  return encodePairingSetupCode(payload);
}

function joinResponse(contentType = "application/json", finalUrl?: string) {
  const release = vi.fn().mockResolvedValue(undefined);
  mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: new Response(JSON.stringify(payload), { headers: { "content-type": contentType } }),
    finalUrl,
    release,
  });
  return release;
}

function expectFailure(message: unknown) {
  expect(mocks.runtime.error).toHaveBeenCalledWith(message);
  expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  expect(mocks.runNodeHost).not.toHaveBeenCalled();
  expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
}

function savedAccessGateway(
  host: string,
  port: number,
  tls: boolean,
  clientId: string,
  clientSecret: string,
) {
  mocks.loadNodeHostConfig.mockResolvedValueOnce({
    version: 1,
    nodeId: "node-test",
    gateway: { host, port, tls, cloudflareAccess: { clientId, clientSecret } },
  });
}

function expectBootstrap() {
  expect(mocks.runNodeHost).toHaveBeenCalledWith(
    expect.objectContaining({ stopAfterFirstConnect: true }),
  );
  expect(mocks.runNodeHost.mock.calls[0]?.[0]).not.toHaveProperty("forceWorkerRuns");
}

async function runConnect(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  registerConnectCli(program);
  await program.parseAsync(["connect", ...args], { from: "user" });
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("connect cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runNodeHost.mockResolvedValue(undefined);
    mocks.runNodeDaemonInstall.mockResolvedValue(undefined);
    mocks.mutateConfigFileWithRetry.mockResolvedValue(undefined);
    mocks.runtime.exit.mockImplementation(() => {});
  });

  it.each(["text/html", "application/json-seq"])(
    "rejects join media type %s",
    async (contentType) => {
      const release = joinResponse(contentType);
      await runConnect([`https://gateway.example/j/${"a".repeat(22)}`]);
      expectFailure("Gateway join code was not found or has expired.");
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("maps an HTTPS join URL into the existing node foreground runtime", async () => {
    const target = `https://gateway.example/openclaw-gw/j/${"a".repeat(22)}`;
    const release = joinResponse("Application/JSON; charset=utf-8", target);

    await runConnect([target, "--display-name", "Build Node"]);

    expect(mocks.runNodeHost).toHaveBeenCalledWith({
      gatewayHost: "192.168.1.20",
      gatewayPort: 8443,
      gatewayTls: true,
      gatewayTlsFingerprint: "ab".repeat(32),
      gatewayContextPath: "/openclaw-gw",
      gatewayCandidates: [
        {
          host: "192.168.1.20",
          port: 8443,
          contextPath: "/openclaw-gw",
          tls: true,
          tlsFingerprint: "ab".repeat(32),
        },
        { host: "gateway.tailnet.example", port: 443, contextPath: "/tailnet-gw", tls: true },
      ],
      gatewayBootstrapToken: "bootstrap-token",
      preferGatewayBootstrapToken: true,
      displayName: "Build Node",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.fetchWithSsrFGuard.mock.calls[0]?.[0]).not.toHaveProperty("init");
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "session-host service under a named profile",
      platform: "linux",
      args: ["--service", "--session-host", "--display-name", "Build --profile test"],
      profile: "work",
      reconnect:
        "openclaw --profile work config set nodeHost.workerRuns.enabled true, then openclaw --profile work node install --force --display-name 'Build --profile test'",
      pair: "openclaw --profile work connect <join-url> --service --session-host --display-name 'Build --profile test'",
    },
    {
      name: "Windows session host",
      platform: "win32",
      args: ["--session-host", "--display-name", "O'Brien"],
      profile: undefined,
      reconnect: "openclaw node run --session-host --display-name 'O''Brien'",
      pair: "openclaw connect <join-url> --session-host --display-name 'O''Brien'",
    },
  ] as const)(
    "points a paired $name without a target at its saved pairing",
    async ({ platform, args, profile, reconnect, pair }) => {
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { configurable: true, value: platform });
      vi.stubEnv("OPENCLAW_PROFILE", profile);
      mocks.loadResumableNodeHostGateway.mockResolvedValueOnce({
        host: "gateway.example",
        port: 443,
        tls: true,
      });

      try {
        await runConnect([...args]);
      } finally {
        if (platformDescriptor) {
          Object.defineProperty(process, "platform", platformDescriptor);
        }
      }

      expectFailure(
        [
          "Connect target is required. Join URLs and setup codes are single-use.",
          `If this machine is still paired with wss://gateway.example:443, reconnect with the saved pairing: ${reconnect}`,
          `Otherwise, mint a join URL on the Gateway host with ${profile ? `openclaw --profile ${profile}` : "openclaw"} devices join-code, then run: ${pair}`,
        ].join("\n"),
      );
    },
  );

  it("only offers a new join URL when no pairing can resume", async () => {
    await runConnect(["--session-host"]);

    expect(mocks.loadResumableNodeHostGateway).toHaveBeenCalledOnce();
    expectFailure(
      "Connect target is required. To pair this machine, mint a join URL on the Gateway host with openclaw devices join-code, then run: openclaw connect <join-url> --session-host",
    );
  });

  it.skipIf(process.platform === "win32").each(["setup-code "])(
    "consumes only the literal target file %j",
    async (fileName) => {
      const root = tempDirs.make("openclaw-connect-literal-target-");
      const targetFile = path.join(root, fileName);
      const neighbor = path.join(root, "setup-code");
      await fs.writeFile(targetFile, setupCode(), { mode: 0o600 });
      await fs.writeFile(neighbor, "unrelated target", { mode: 0o600 });

      await runConnect(["--target-file", targetFile, "--ephemeral"]);

      expect(mocks.runNodeHost).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayPort: 8443, forceWorkerRuns: true }),
      );
      await expect(fs.stat(targetFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(neighbor, "utf8")).resolves.toBe("unrelated target");
    },
  );

  it.each([
    ["empty", Buffer.alloc(0), "Connect target file is empty."],
    ["truncated UTF-8", Buffer.from([0xe2, 0x82]), "Connect target file must be valid UTF-8."],
    ["oversized", Buffer.alloc(64 * 1024 + 1, 0x61), "max 65536 bytes"],
  ] as const)("rejects a %s target file without removing it", async (_name, contents, message) => {
    const root = tempDirs.make("openclaw-connect-target-invalid-");
    const targetFile = path.join(root, "setup-code");
    await fs.writeFile(targetFile, contents, { mode: 0o600 });

    await runConnect(["--target-file", targetFile, "--ephemeral"]);

    expectFailure(expect.stringContaining(message));
    await expect(fs.readFile(targetFile)).resolves.toEqual(contents);
  });

  it.each(["--service", "--session-host"])("rejects --ephemeral with %s", async (flag) => {
    await runConnect([setupCode(), "--ephemeral", flag]);
    expectFailure(`--ephemeral cannot be combined with ${flag}.`);
  });

  it("forwards repeatable command restrictions through service connect", async () => {
    await runConnect([
      setupCode(),
      "--service",
      "--commands",
      "fixture.read,fixture.list",
      "--commands",
      "fixture.read",
    ]);
    const commands = ["fixture.list", "fixture.read"];
    expect(mocks.runNodeHost).toHaveBeenCalledWith(expect.objectContaining({ commands }));
    expect(mocks.runNodeHost.mock.calls[0]?.[0]).not.toHaveProperty("forceWorkerRuns");
    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    expect(mocks.runNodeDaemonInstall).toHaveBeenCalledWith(
      expect.objectContaining({ commands, force: true }),
    );
  });

  it("rejects --all-commands with --commands before consuming the join target", async () => {
    await expect(
      runConnect([setupCode(), "--all-commands", "--commands", "fixture.read"]),
    ).rejects.toThrow(/--all-commands.*--commands/);
    expect(mocks.loadNodeHostConfig).not.toHaveBeenCalled();
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it("authenticates before persisting hosting consent and installing the service", async () => {
    await runConnect([setupCode(), "--service", "--session-host", "--display-name", "Runner Node"]);

    expectBootstrap();
    expect(mocks.mutateConfigFileWithRetry).toHaveBeenCalledWith({
      writeOptions: {
        auditOrigin: "cli",
        explicitSetPaths: [["nodeHost", "workerRuns", "enabled"]],
      },
      mutate: expect.any(Function),
    });
    const mutation = mocks.mutateConfigFileWithRetry.mock.calls[0]?.[0] as {
      mutate: (draft: OpenClawConfig) => void;
    };
    const draft: OpenClawConfig = {
      gateway: { port: 28443 },
      nodeHost: { skills: { enabled: false }, workerRuns: { enabled: false } },
    };
    mutation.mutate(draft);
    expect(draft).toEqual({
      gateway: { port: 28443 },
      nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true } },
    });
    expect(mocks.runNodeDaemonInstall).toHaveBeenCalledWith({
      displayName: "Runner Node",
      force: true,
    });
    expect(mocks.runNodeHost.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mutateConfigFileWithRetry.mock.invocationCallOrder[0]!,
    );
    expect(mocks.mutateConfigFileWithRetry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runNodeDaemonInstall.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    { stage: "bootstrap connection", error: "bootstrap failed", mutationCalls: 0 },
    { stage: "durable consent write", error: "config write failed", mutationCalls: 1 },
  ])("does not install the service when the $stage fails", async ({ error, mutationCalls }) => {
    if (mutationCalls === 0) {
      mocks.runNodeHost.mockRejectedValueOnce(new Error(error));
    } else {
      mocks.mutateConfigFileWithRetry.mockRejectedValueOnce(new Error(error));
    }

    await runConnect([setupCode(), "--service", "--session-host"]);

    expectBootstrap();
    expect(mocks.mutateConfigFileWithRetry).toHaveBeenCalledTimes(mutationCalls);
    expect(mocks.runtime.error).toHaveBeenCalledWith(error);
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it("refuses plain HTTP join URLs for non-loopback gateways", async () => {
    await runConnect([`http://gateway.example/j/${"a".repeat(22)}`]);

    expectFailure("Plain HTTP join URLs are allowed only for loopback gateways.");
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("sends Cloudflare Access credentials on the pinned HTTPS join request", async () => {
    const clientId = ["cf", "client", "id"].join("-");
    const clientSecret = ["cf", "client", "secret"].join("-");
    savedAccessGateway("gateway.example", 443, true, clientId, clientSecret);
    const target = `https://gateway.example/j/${"a".repeat(22)}`;
    joinResponse("application/json", target);

    await runConnect([target]);

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRedirects: 0,
        init: {
          headers: {
            "CF-Access-Client-Id": clientId,
            "CF-Access-Client-Secret": clientSecret,
          },
        },
      }),
    );
  });

  it("rejects Cloudflare Access credentials before a plaintext join request", async () => {
    const clientSecret = ["cf", "plaintext", "secret"].join("-");
    savedAccessGateway("127.0.0.1", 80, false, "cf-plaintext-id", clientSecret);

    await runConnect([`http://127.0.0.1/j/${"a".repeat(22)}`]);

    expectFailure("Cloudflare Access credentials require an HTTPS join URL.");
    expect(String(mocks.runtime.error.mock.calls[0]?.[0])).not.toContain(clientSecret);
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
