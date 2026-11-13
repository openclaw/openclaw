import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  call: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(),
  prompt: vi.fn<() => Promise<boolean>>(),
  log: vi.fn<(line: string) => void>(),
}));

vi.mock("./gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: (
    method: string,
    _opts: unknown,
    params: Record<string, unknown>,
  ) => mocks.call(method, params),
}));
vi.mock("./prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prompt.js")>()),
  promptYesNo: mocks.prompt,
}));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: { log: mocks.log, error: vi.fn(), exit: vi.fn(), writeJson: vi.fn() },
}));

import { registerPairCli } from "./pair-cli.js";

const request = {
  status: "pending",
  requestId: "request-1",
  code: "ABCDEFGH",
  deviceId: "0123456789abcdef",
  remoteIp: "203.0.113.7",
  userAgent: "\u001b[32mSafe Browser\u001b[0m",
  origin: "https://gateway.example",
  createdAtMs: Date.now() - 120_000,
  expiresAtMs: Date.now() + 480_000,
};

async function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerPairCli(program);
  await program.parseAsync(["pair", ...args], { from: "user" });
}

function setTty(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

const decisions = () => mocks.call.mock.calls.map(([, params]) => params.decision);
const output = () => mocks.log.mock.calls.map(([line]) => line).join("\n");

describe("openclaw pair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.call.mockResolvedValue(request);
  });

  it("shows who is asking and approves only after the operator agrees", async () => {
    setTty(true);
    mocks.prompt.mockResolvedValue(true);
    await run("abcd-efgh");
    expect(mocks.call).toHaveBeenCalledWith("device.pair.code", { code: "ABCDEFGH" });
    expect(output()).toMatch(/Address +203\.0\.113\.7/u);
    expect(output()).toMatch(/Page \(reported\) +https:\/\/gateway\.example/u);
    expect(output()).toMatch(/Browser \(reported\) +Safe Browser/u);
    expect(output()).toContain("01234567");
    expect(output()).toContain("2 minutes ago");
    expect(output()).toContain("If someone sent you this code");
    expect(output()).not.toContain("\u001b");
    expect(mocks.call).toHaveBeenCalledWith("device.pair.code", {
      code: "ABCDEFGH",
      requestId: "request-1",
      decision: "approve",
    });
  });

  it("rejects the request when the operator answers no", async () => {
    setTty(true);
    mocks.prompt.mockResolvedValue(false);
    await run("ABCD-EFGH");
    expect(decisions()).toEqual([undefined, "reject"]);
  });

  it("approves nothing from a terminal that cannot answer", async () => {
    setTty(false);
    await expect(run("ABCD-EFGH")).rejects.toThrow("Nothing was approved");
    expect(decisions()).toEqual([undefined]);
  });

  it("refuses text that is not a code before calling the Gateway", async () => {
    await expect(run("not a code")).rejects.toThrow("not a pairing code");
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
