import { describe, expect, it } from "vitest";

type GatewayRunArgvModule = {
  isGatewayRunInvocationArgv?: (argv: string[]) => boolean;
};

describe("isGatewayRunInvocationArgv", () => {
  it("matches the same bare gateway and gateway run shapes used by deferred activation", async () => {
    const { isGatewayRunInvocationArgv } =
      (await import("./gateway-run-argv.js")) as GatewayRunArgvModule;

    expect(isGatewayRunInvocationArgv).toBeTypeOf("function");

    expect(isGatewayRunInvocationArgv!(["node", "openclaw", "gateway"])).toBe(true);
    expect(isGatewayRunInvocationArgv!(["node", "openclaw", "gateway", "run"])).toBe(true);
    expect(
      isGatewayRunInvocationArgv!(["node", "openclaw", "--no-color", "gateway", "run", "--force"]),
    ).toBe(true);
    expect(isGatewayRunInvocationArgv!(["node", "openclaw", "gateway", "--bind", "loopback"])).toBe(
      true,
    );
    expect(isGatewayRunInvocationArgv!(["node", "openclaw", "gateway", "--help"])).toBe(true);
    expect(isGatewayRunInvocationArgv!(["node", "openclaw", "gateway", "call", "health"])).toBe(
      false,
    );
    expect(isGatewayRunInvocationArgv!(["node", "openclaw", "gateway", "status"])).toBe(false);
    expect(isGatewayRunInvocationArgv!(["node", "openclaw", "status"])).toBe(false);
  });
});
