import { beforeEach, expect, it, vi } from "vitest";
import {
  logGatewayConnectionDetails,
  resolveStatusAllConnectionDetails,
} from "./status.gateway-connection.js";
import { resolveNodeOnlyGatewayInfo } from "./status.node-mode.js";

const mocks = vi.hoisted(() => ({ loadNodeHostConfig: vi.fn() }));
vi.mock("../node-host/config.js", () => ({
  loadNodeHostConfig: mocks.loadNodeHostConfig,
}));
beforeEach(() => mocks.loadNodeHostConfig.mockReset());
const connection = {
  nodeOnlyGateway: null,
  remoteUrlMissing: true,
  gatewayConnection: {
    url: "ws://user:secret@127.0.0.1:18789?token=abc123",
    urlSource: "env",
    message: "ignored",
  },
  bindMode: "loopback",
  configPath: "/tmp/openclaw.json",
};

it("does not claim node-only mode when the node service is installed but inactive", async () => {
  await expect(
    resolveNodeOnlyGatewayInfo({
      daemon: { installed: false },
      node: {
        installed: true,
        loadState: { status: "not-loaded" },
        externallyManaged: false,
        runtime: { status: "stopped" },
      },
    }),
  ).resolves.toBeNull();
});

it("prefers node-only diagnostics with an unknown target when node config is missing", async () => {
  mocks.loadNodeHostConfig.mockResolvedValueOnce(null);
  const nodeOnlyGateway = await resolveNodeOnlyGatewayInfo({
    daemon: { installed: false },
    node: { installed: true, loadState: { status: "loaded" }, externallyManaged: false },
  });
  expect(nodeOnlyGateway).toMatchObject({
    gatewayTarget: "(gateway address unknown)",
    gatewayValue: "node → (gateway address unknown) · no local gateway",
  });
  expect(resolveStatusAllConnectionDetails({ ...connection, nodeOnlyGateway })).toBe(
    [
      "Node-only mode detected",
      "Local gateway: not expected on this machine",
      "Remote gateway target: (gateway address unknown)",
      "Inspect the remote gateway host for live channel and health details.",
    ].join("\n"),
  );
});

it("redacts credentials from the remote fallback URL", () => {
  const details = resolveStatusAllConnectionDetails(connection);
  expect(details).not.toContain("secret");
  expect(details).not.toContain("abc123");
  expect(details).toContain("ws://***:***@127.0.0.1:18789/?token=***");
});

it("logs gateway connection details with indentation", () => {
  const runtime = { log: vi.fn() };
  logGatewayConnectionDetails({
    runtime,
    info: (value) => `info:${value}`,
    message: "Gateway mode: local\nGateway target: ws://127.0.0.1:18789",
    trailingBlankLine: true,
  });
  expect(runtime.log.mock.calls).toEqual([
    ["info:Gateway connection:"],
    ["  Gateway mode: local"],
    ["  Gateway target: ws://127.0.0.1:18789"],
    [""],
  ]);
});
