import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResetPreparation } from "../gateway/openclaw-id/reset-operations.js";

const gateway = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./gateway-rpc.js", () => ({ callGatewayFromCli: gateway.call }));
vi.mock("./prompt.js", () => ({ promptText: vi.fn(async () => "studio") }));

const prep: ResetPreparation = {
  claw_id: "0123456789abcdef0123456789abcdef",
  hostname: "studio-k7x2q.claws.example.test",
  root_pub: `ed25519:${"1".repeat(64)}`,
  k_srv: `iroh:${"2".repeat(64)}`,
  k_gw: `ed25519:${"3".repeat(64)}`,
  binding_seq: 2,
  root_epoch: 1,
  owner_device_seq: 3,
  removes: { ownerDevices: 1, members: 2, nodes: 0, invites: 1 },
};

let output: string[];
const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

beforeEach(() => {
  output = [];
  gateway.call.mockReset();
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.stdin.isTTY = tty.stdin;
  process.stdout.isTTY = tty.stdout;
  process.exitCode = undefined;
});

const params = () => gateway.call.mock.calls.map((call) => call[2] as Record<string, unknown>);

describe("openclaw id reset", () => {
  it("sends the owner account's code with both steps and shows the new kit once", async () => {
    gateway.call.mockResolvedValueOnce(prep).mockResolvedValueOnce({
      ok: true,
      reset: true,
      bindingSeq: 2,
      removed: prep.removes,
      publication: { state: "published" },
    });
    const { runReset } = await import("./id-cli-reset.js");
    await runReset({}, async () => "LINK-CODE-1");
    expect(params()).toEqual([
      { action: "reset_prepare", code: "LINK-CODE-1" },
      expect.objectContaining({ action: "reset_commit", code: "LINK-CODE-1" }),
    ]);
    // The binding the new kit signed names the staged K_gw' and the kept K_srv.
    expect(params()[1]?.binding).toMatchObject({ body: { k_gw: prep.k_gw, k_srv: prep.k_srv } });
    const text = output.join("");
    expect(text).toContain("Discovery has the new owner key.");
    expect(text.match(/OCK1-[A-Z0-9-]+/g)).toHaveLength(1);
    expect(JSON.stringify(params())).not.toMatch(/OCK1-/);
  });

  it("changes nothing and shows no kit when the name doesn't match", async () => {
    gateway.call.mockResolvedValueOnce(prep);
    const prompt = await import("./prompt.js");
    vi.mocked(prompt.promptText).mockResolvedValueOnce("someone-else");
    const { runReset } = await import("./id-cli-reset.js");
    await runReset({}, async () => "LINK-CODE-1");
    expect(params()).toEqual([{ action: "reset_prepare", code: "LINK-CODE-1" }]);
    expect(output.join("")).toContain("Not reset.");
    expect(output.join("")).not.toMatch(/OCK1-/);
  });

  it("shows no kit for a Gateway refusal, but keeps it when the outcome is unknown", async () => {
    const refusal = Object.assign(new Error("the link code is unknown"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
      retryable: false,
      details: { code: "code_invalid" },
    });
    gateway.call.mockResolvedValueOnce(prep).mockRejectedValueOnce(refusal);
    const { runReset } = await import("./id-cli-reset.js");
    await expect(runReset({}, async () => "LINK-CODE-1")).rejects.toBe(refusal);
    expect(output.join("")).not.toMatch(/OCK1-/);

    output.length = 0;
    gateway.call.mockResolvedValueOnce(prep).mockRejectedValueOnce(new Error("socket closed"));
    await runReset({}, async () => "LINK-CODE-1");
    expect(output.join("")).toContain("The reset may have been applied.");
    expect(output.join("").match(/OCK1-[A-Z0-9-]+/g)).toHaveLength(1);
    expect(process.exitCode).toBe(2);
  });
});
