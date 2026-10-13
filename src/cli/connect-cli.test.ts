// Connect CLI tests cover accepted targets and handoff to the canonical node runtime.
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
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
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

  it.each([
    {
      name: "HTTPS join URL",
      target: () => `https://gateway.example/openclaw-gw/j/${"a".repeat(22)}`,
      fetched: true,
    },
  ])("maps a $name into the existing node foreground runtime", async ({ target, fetched }) => {
    if (fetched) {
      mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response: new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
        finalUrl: target(),
        release: vi.fn().mockResolvedValue(undefined),
      });
    }

    await runConnect([target(), "--display-name", "Build Node"]);

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
        {
          host: "gateway.tailnet.example",
          port: 443,
          contextPath: "/tailnet-gw",
          tls: true,
        },
      ],
      gatewayBootstrapToken: "bootstrap-token",
      preferGatewayBootstrapToken: true,
      displayName: "Build Node",
    });
    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(fetched ? 1 : 0);
    if (fetched) {
      expect(mocks.fetchWithSsrFGuard.mock.calls[0]?.[0]).not.toHaveProperty("init");
    }
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

      expect(mocks.runtime.error).toHaveBeenCalledWith(
        [
          "Connect target is required. Join URLs and setup codes are single-use.",
          `If this machine is still paired with wss://gateway.example:443, reconnect with the saved pairing: ${reconnect}`,
          `Otherwise, mint a join URL on the Gateway host with ${profile ? `openclaw --profile ${profile}` : "openclaw"} devices join-code, then run: ${pair}`,
        ].join("\n"),
      );
      expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.runNodeHost).not.toHaveBeenCalled();
      expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
      expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
    },
  );

  it("only offers a new join URL when no pairing can resume", async () => {
    await runConnect(["--session-host"]);

    expect(mocks.loadResumableNodeHostGateway).toHaveBeenCalledOnce();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Connect target is required. To pair this machine, mint a join URL on the Gateway host with openclaw devices join-code, then run: openclaw connect <join-url> --session-host",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
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
    {
      name: "empty",
      contents: Buffer.alloc(0),
      message: "Connect target file is empty.",
    },
    {
      name: "truncated UTF-8",
      contents: Buffer.from([0xe2, 0x82]),
      message: "Connect target file must be valid UTF-8.",
    },
    {
      name: "oversized",
      contents: Buffer.alloc(64 * 1024 + 1, 0x61),
      message: "max 65536 bytes",
    },
  ])("rejects an $name target file without removing it", async ({ contents, message }) => {
    const root = tempDirs.make("openclaw-connect-target-invalid-");
    const targetFile = path.join(root, "setup-code");
    await fs.writeFile(targetFile, contents, { mode: 0o600 });

    await runConnect(["--target-file", targetFile, "--ephemeral"]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
    await expect(fs.readFile(targetFile)).resolves.toEqual(contents);
  });

  it.each([
    {
      args: ["--ephemeral", "--service"],
      message: "--ephemeral cannot be combined with --service.",
    },
    {
      args: ["--ephemeral", "--session-host"],
      message: "--ephemeral cannot be combined with --session-host.",
    },
  ])("rejects incompatible flags: $args", async ({ args, message }) => {
    await runConnect([setupCode(), ...args]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(message);
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it("keeps the existing service path non-hosting", async () => {
    await runConnect([setupCode(), "--service", "--display-name", "Service Node"]);

    expect(mocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayBootstrapToken: "bootstrap-token",
        stopAfterFirstConnect: true,
      }),
    );
    expect(mocks.runNodeHost.mock.calls[0]?.[0]).not.toHaveProperty("forceWorkerRuns");
    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    expect(mocks.runNodeDaemonInstall).toHaveBeenCalledWith({
      displayName: "Service Node",
      force: true,
    });
  });

  it.each([true])(
    "forwards repeatable command restrictions through connect (service=%s)",
    async (service) => {
      await runConnect([
        setupCode(),
        ...(service ? ["--service"] : []),
        "--commands",
        "fixture.read,fixture.list",
        "--commands",
        "fixture.read",
      ]);
      const commands = ["fixture.list", "fixture.read"];
      expect(mocks.runNodeHost).toHaveBeenCalledWith(expect.objectContaining({ commands }));
      if (service) {
        expect(mocks.runNodeDaemonInstall).toHaveBeenCalledWith(
          expect.objectContaining({ commands, force: true }),
        );
      } else {
        expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
      }
    },
  );

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

    expect(mocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        stopAfterFirstConnect: true,
      }),
    );
    expect(mocks.runNodeHost.mock.calls[0]?.[0]).not.toHaveProperty("forceWorkerRuns");
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

    expect(mocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({ stopAfterFirstConnect: true }),
    );
    expect(mocks.runNodeHost.mock.calls[0]?.[0]).not.toHaveProperty("forceWorkerRuns");
    expect(mocks.mutateConfigFileWithRetry).toHaveBeenCalledTimes(mutationCalls);
    expect(mocks.runtime.error).toHaveBeenCalledWith(error);
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it("refuses plain HTTP join URLs for non-loopback gateways", async () => {
    await runConnect([`http://gateway.example/j/${"a".repeat(22)}`]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Plain HTTP join URLs are allowed only for loopback gateways.",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
  });

  it("sends Cloudflare Access credentials on the pinned HTTPS join request", async () => {
    const clientId = ["cf", "client", "id"].join("-");
    const clientSecret = ["cf", "client", "secret"].join("-");
    mocks.loadNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-test",
      gateway: {
        host: "gateway.example",
        port: 443,
        tls: true,
        cloudflareAccess: { clientId, clientSecret },
      },
    });
    const target = `https://gateway.example/j/${"a".repeat(22)}`;
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      finalUrl: target,
      release: vi.fn(async () => undefined),
    });

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
    mocks.loadNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-test",
      gateway: {
        host: "127.0.0.1",
        port: 80,
        tls: false,
        cloudflareAccess: { clientId: "cf-plaintext-id", clientSecret },
      },
    });

    await runConnect([`http://127.0.0.1/j/${"a".repeat(22)}`]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Cloudflare Access credentials require an HTTPS join URL.",
    );
    expect(String(mocks.runtime.error.mock.calls[0]?.[0])).not.toContain(clientSecret);
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
  });
});
