import net from "node:net";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { describe, expect, it, vi } from "vitest";
import { inspectPortUsage, inspectPortUsages } from "./ports-inspect.js";

const runCommand = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: runCommand }));

const describeUnix = process.platform === "win32" ? describe.skip : describe;

describeUnix("family-scoped port inspection", () => {
  it("keeps IPv4 free beside an IPv6-only wildcard reported by lsof", async ({ skip }) => {
    await using server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "::", ipv6Only: true, port: 0 }, resolve);
    }).catch((error: unknown) => {
      const code = extractErrorCode(error);
      if (code && ["EPERM", "EACCES", "EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(code)) {
        skip(`IPv6 listener bind unavailable: ${code}`);
      }
      throw error;
    });
    const port = (server.address() as net.AddressInfo).port;
    runCommand.mockImplementation(async (argv: string[]) => ({
      stdout: argv[0]?.includes("lsof") ? `p111\ncnode\nn*:${port}\n` : "",
      stderr: "",
      code: argv[0]?.includes("lsof") ? 0 : 1,
    }));

    const single = await inspectPortUsage(port, { probeHosts: ["127.0.0.1"] });
    const batch = await inspectPortUsages([port], {
      probeHostsByPort: new Map([[port, ["127.0.0.1"]]]),
    });
    for (const result of [single, batch.get(port)]) {
      expect(result).toMatchObject({ status: "free", listeners: [], hints: [] });
    }
  });
});
