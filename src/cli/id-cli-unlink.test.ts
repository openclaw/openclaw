import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { describePendingUnlinks, describeUnlinkWarning, runUnlink } from "./id-cli-unlink.js";
import { promptYesNo } from "./prompt.js";

vi.mock(import("./gateway-rpc.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  callGatewayFromCli: vi.fn(),
}));
vi.mock(import("./prompt.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  promptYesNo: vi.fn(),
}));

const preview = {
  claw_id: "c".repeat(32),
  hostname: "studio-k7x2q.claws.example.test",
  people: 2,
  devices: 4,
  ownerDevices: 1,
  memberDevices: 3,
  nodes: 0,
};

let output: string;
let actions: unknown[];
let discovery: string;

beforeEach(() => {
  output = "";
  actions = [];
  discovery = "pending";
  vi.mocked(promptYesNo).mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.mocked(callGatewayFromCli).mockImplementation(async (_method, _opts, raw) => {
    // SAFETY: runUnlink sends only { action, clawId? } to openclawId.authority.
    const params = raw as { action?: string; clawId?: string } | undefined;
    actions.push(params?.action === "unlink" ? `unlink:${String(params.clawId)}` : params?.action);
    return params?.action === "unlink_preview"
      ? preview
      : { ok: true, unlinked: true, hostname: preview.hostname, discovery };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const write = (json: unknown, text: string) => {
  output += `${text}\n`;
};

describe("openclaw id unlink", () => {
  it("warns with the counts, the address and the retired name", () => {
    expect(describeUnlinkWarning(preview)).toBe(
      [
        "Unlink studio-k7x2q.claws.example.test from OpenClaw ID?",
        "  - 2 people and 4 devices lose access now (1 owner device, 3 member devices). Members are removed; linking again starts with no one.",
        "  - https://studio-k7x2q.claws.example.test stops working at once.",
        '  - The name "studio" can never be used again, by any account.',
        "  - Conversations and everything else on this computer stay. You can link it again later as a new claw.",
      ].join("\n"),
    );
  });

  it("changes nothing when the owner declines", async () => {
    vi.mocked(promptYesNo).mockResolvedValue(false);
    await runUnlink({}, write);
    expect(actions).toEqual(["unlink_preview"]);
    expect(output).toContain("lose access now");
    expect(output).toContain("Not unlinked. Nothing changed.");
  });

  it("unlinks after confirmation and says when Discovery still needs it", async () => {
    vi.mocked(promptYesNo).mockResolvedValue(true);
    await runUnlink({}, write);
    expect(actions).toEqual(["unlink_preview", `unlink:${"c".repeat(32)}`]);
    expect(output).toContain("Unlinked studio-k7x2q.claws.example.test.");
    expect(output).toContain("OpenClaw ID couldn't be reached");
  });

  it("reports a never-registered claw as unlinked here only, and a waiting unlink in status", async () => {
    discovery = "local_only";
    await runUnlink({ yes: true }, write);
    expect(output).toContain("OpenClaw ID never registered this claw");
    expect(output).not.toMatch(/retired|can't be used again/);
    expect(process.exitCode).toBeUndefined();
    discovery = "pending";
    await runUnlink({ yes: true }, write);
    expect(process.exitCode).toBeUndefined();
    expect(describePendingUnlinks([{ hostname: preview.hostname }])).toEqual([
      `Unlink pending: ${preview.hostname} is unlinked here; OpenClaw ID gets the unlink when it can be reached.`,
    ]);
    discovery = "refused";
    await runUnlink({ yes: true }, write);
    expect(process.exitCode).toBe(2);
  });

  it("skips the question with --yes, and --json needs --yes", async () => {
    await runUnlink({ yes: true }, write);
    expect(promptYesNo).not.toHaveBeenCalled();
    expect(actions).toEqual(["unlink_preview", `unlink:${"c".repeat(32)}`]);
    await expect(runUnlink({ json: true }, write)).rejects.toThrow("--json needs --yes");
  });
});
