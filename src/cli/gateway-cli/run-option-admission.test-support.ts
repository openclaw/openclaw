// Share the command suite's startup mocks and reset lifecycle for option admission cases.
import { expect, it, type Mock } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";

export function registerGatewayOptionAdmissionTests({
  runGatewayCli,
  startGatewayServer,
  runtimeErrors,
  configState,
  prepareGatewayReset,
  ensureDevGatewayConfig,
}: {
  runGatewayCli: (args: string[]) => Promise<unknown>;
  startGatewayServer: Mock;
  runtimeErrors: string[];
  configState: { snapshot: Record<string, unknown> };
  prepareGatewayReset: () => Promise<unknown>;
  ensureDevGatewayConfig: Mock;
}) {
  it("allows ambient channel triggers with the deprecated alias", async () => {
    await runGatewayCli(["gateway", "run", "--allow-unconfigured", "--dev-ambient-channels"]);
    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({ ambientEnvTriggers: "allow" }),
    );
  });

  it("prints all supported modes on invalid --auth value", async () => {
    await expect(
      runGatewayCli(["gateway", "--auth", "bad-mode", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      'Invalid --auth. Use "none", "token", "password", or "trusted-proxy".',
    );
  });

  it.each([false, true])(
    "rejects malformed selected published-port input before dev reset (%s)",
    async (inherited) => {
      const config = { gateway: { mode: "local" } };
      configState.snapshot = { config, sourceConfig: config, exists: true, valid: true };
      await prepareGatewayReset();
      await withEnvAsync(
        { OPENCLAW_CONTAINER_PUBLISHED_GATEWAY_PORT: inherited ? "0" : undefined },
        async () => {
          await expect(
            runGatewayCli([
              "gateway",
              "run",
              "--allow-unconfigured",
              "--dev",
              "--reset",
              ...(inherited ? [] : ["--published-port", "0"]),
            ]),
          ).rejects.toThrow();
        },
      );
      expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
      expect(startGatewayServer).not.toHaveBeenCalled();
    },
  );

  it.each([
    { args: ["gateway", "--published-port", "19123"] },
    { args: ["gateway", "--published-port", "19123", "run"] },
    { args: ["gateway", "run", "--published-port", "19123"] },
  ])("passes the mapped host port through startup (%j)", async ({ args }) => {
    await runGatewayCli([...args, "--allow-unconfigured"]);
    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({ publishedPort: 19123 }),
    );
  });

  it.each([
    { input: "19123", args: [], expected: 19123 },
    { input: "invalid", args: ["--published-port", "29123"], expected: 29123 },
  ])(
    "uses container port metadata unless explicitly overridden (%j)",
    async ({ input, args, expected }) => {
      await withEnvAsync({ OPENCLAW_CONTAINER_PUBLISHED_GATEWAY_PORT: input }, async () => {
        await runGatewayCli(["gateway", ...args, "--allow-unconfigured"]);
        expect(startGatewayServer).toHaveBeenCalledWith(
          18789,
          expect.objectContaining({ publishedPort: expected }),
        );
      });
    },
  );

  it.each(["0", "65536", "19123junk"])(
    "rejects invalid published port %s before startup",
    async (port) => {
      await expect(
        runGatewayCli(["gateway", "--published-port", port, "--allow-unconfigured"]),
      ).rejects.toThrow("__exit__:1");
      expect(startGatewayServer).not.toHaveBeenCalled();
      expect(runtimeErrors.join("\n")).toContain(
        "Invalid --published-port. Use a port number from 1 to 65535",
      );
    },
  );

  it("rejects invalid gateway ports before startup", async () => {
    await expect(
      runGatewayCli(["gateway", "--port", "0", "--token", "test-token"]),
    ).rejects.toThrow("__exit__:1");

    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Invalid --port. Use a port number from 1 to 65535");
  });
}
