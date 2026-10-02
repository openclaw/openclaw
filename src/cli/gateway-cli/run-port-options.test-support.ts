// Share the command suite's startup mocks and reset lifecycle for port admission cases.
import { expect, it, type Mock } from "vitest";

export function registerGatewayPortOptionTests({
  runGatewayCli,
  startGatewayServer,
  runtimeErrors,
}: {
  runGatewayCli: (args: string[]) => Promise<unknown>;
  startGatewayServer: Mock;
  runtimeErrors: string[];
}) {
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
