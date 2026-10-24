import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../../cron/scratch-contract.js";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return { ...actual, callGatewayFromCli };
});

const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");
const { registerCronScratchCommand } = await import("./register.cron-scratch.js");
const { readCronPayloadScript, readCronTriggerScript, readCronScratchContent } =
  await import("./trigger-options.js");
let fixtureRoot = "";

async function fixture(name: string, content: string | Buffer) {
  if (name !== name.trim()) {
    await fs.writeFile(path.join(fixtureRoot, name.trim()), "wrong file", "utf8");
  }
  const file = path.join(fixtureRoot, name);
  await fs.writeFile(file, content);
  return file;
}

function expectRequest(method: string, payload: unknown) {
  expect(callGatewayFromCli).toHaveBeenCalledWith(method, expect.anything(), payload);
}

async function run(operation: "add" | "edit", options: Record<string, string | true>) {
  const program = new Command().exitOverride();
  (operation === "add" ? registerCronAddCommand : registerCronEditCommand)(program);
  const prefix = operation === "add" ? ["add"] : ["edit", "job-1"];
  const values = operation === "add" ? { name: "watcher", every: "30s", ...options } : options;
  const args = Object.entries(values).flatMap(([key, value]) =>
    value === true ? [`--${key}`] : [`--${key}`, value],
  );
  await program.parseAsync([...prefix, ...args], { from: "user" });
}

async function rejectAdd(options: Record<string, string | true>, message: string) {
  await expect(run("add", options)).rejects.toMatchObject({ name: "ExitError", code: 1 });
  expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(message));
  expect(callGatewayFromCli).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("cron trigger CLI options", () => {
  it.each([
    ["Trigger script", readCronTriggerScript],
    ["Script payload", readCronPayloadScript],
    ["Cron scratch", readCronScratchContent],
  ] as const)("rejects malformed UTF-8 for %s from files and stdin", async (label, read) => {
    const bytes = Buffer.from([0x78, 0xff, 0x79]);
    const file = await fixture("invalid.txt", bytes);
    await expect(read(file)).rejects.toThrow(`${label} must be valid UTF-8`);
    const stdin = vi
      .spyOn(process.stdin, Symbol.asyncIterator)
      .mockImplementation(() => Readable.from([bytes])[Symbol.asyncIterator]());
    try {
      await expect(read("-")).rejects.toThrow(`${label} must be valid UTF-8`);
    } finally {
      stdin.mockRestore();
    }
  });

  it("preserves exact scratch BOM, Unicode and CRLF while scripts retain trimming", async () => {
    const text = "\uFEFF 中文 😀 \uFFFD\r\n";
    const file = await fixture("valid.txt", text);
    await expect(readCronScratchContent(file)).resolves.toBe(text);
    await expect(readCronTriggerScript(file)).resolves.toBe("中文 😀 \uFFFD");
    await expect(readCronPayloadScript(file)).resolves.toBe("中文 😀 \uFFFD");
  });

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cron-trigger-cli-"));
    callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("reads the exact trigger path on add", async () => {
    const scriptPath = await fixture("watch.js ", "  json({ fire: true })  \n");
    await run("add", {
      "trigger-script": scriptPath,
      "trigger-once": true,
      "system-event": "changed",
      session: "main",
    });

    expectRequest(
      "cron.add",
      expect.objectContaining({ trigger: { script: "json({ fire: true })", once: true } }),
    );
  });

  it("rejects an explicitly blank trigger script before adding a job", async () => {
    await rejectAdd(
      { "trigger-script": "   ", "system-event": "changed", session: "main" },
      "--trigger-script must not be blank",
    );
  });

  it.each(["add", "edit"] as const)(
    "reads the exact payload path and budgets on %s",
    async (operation) => {
      const scriptPath = await fixture("job.js ", "  return { notify: 'done' }  \n");
      await run(operation, {
        script: scriptPath,
        "script-timeout-seconds": "450",
        "script-tool-budget": "75",
        ...(operation === "add" ? { session: "isolated" } : {}),
      });

      const payload = {
        kind: "script",
        script: "return { notify: 'done' }",
        timeoutSeconds: 450,
        toolBudget: 75,
      };
      expectRequest(
        operation === "add" ? "cron.add" : "cron.update",
        operation === "add"
          ? expect.objectContaining({ sessionTarget: "isolated", payload })
          : { id: "job-1", patch: { payload } },
      );
    },
  );

  it("rejects script creation with a generic timeout", async () => {
    const scriptPath = await fixture("job.js", "return { notify: 'done' }");
    await rejectAdd(
      { name: "script job", script: scriptPath, "timeout-seconds": "30" },
      "Use --script-timeout-seconds for script jobs, not --timeout-seconds.",
    );
  });

  it("sends pacing bounds on add", async () => {
    await run("add", {
      name: "paced",
      every: "30m",
      "pacing-min": "15m",
      "pacing-max": "4h",
      "system-event": "check",
      session: "main",
    });

    expectRequest("cron.add", expect.objectContaining({ pacing: { min: "15m", max: "4h" } }));
  });

  it.each(["trigger", "pacing"])("maps --clear-%s to a nullable edit patch", async (field) => {
    await run("edit", { [`clear-${field}`]: true });
    expectRequest("cron.update", { id: "job-1", patch: { [field]: null } });
  });
});

describe("cron scratch", () => {
  async function runScratch(args: string[]) {
    const program = new Command().exitOverride();
    registerCronScratchCommand(program);
    await program.parseAsync(["scratch", "job-1", ...args], { from: "user" });
  }
  const result = { ok: true, scratch: null, currentRevision: 3, maxBytes: 1024 };
  const current = { ...result, currentRevision: 2 };
  beforeEach(() => {
    callGatewayFromCli
      .mockReset()
      .mockImplementation(async (method: string) =>
        method === "cron.scratch.get" ? current : result,
      );
  });

  function expectRpc(...calls: ["get" | "set", Record<string, unknown>][]) {
    expect(callGatewayFromCli.mock.calls).toEqual(
      calls.map(([method, params]) => [
        `cron.scratch.${method}`,
        expect.anything(),
        { id: "job-1", ...params },
      ]),
    );
  }

  async function expectFailure(args: string[], message: string) {
    await expect(runScratch(args)).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(message));
  }

  it("uses the read revision for an implicit CAS write and prints JSON", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    await runScratch(["--set", "new note"]);
    expect(json).toHaveBeenCalledExactlyOnceWith(result);
    expect(stdout).not.toHaveBeenCalled();
    expectRpc(["get", {}], ["set", { content: "new note", expectedRevision: 2 }]);
  });

  it("rejects non-decimal revisions after reading but before writing", async () => {
    await expectFailure(
      ["--set", "x", "--expected-revision", "0x2"],
      "--expected-revision must be a non-negative integer",
    );
    expectRpc(["get", {}]);
  });

  it.each([
    ["0", ["--set", "x"], "x"],
    ["42", ["--unset", "--json"], null],
  ] as const)("writes at explicit revision %s without a read", async (revision, args, content) => {
    await runScratch([...args, "--expected-revision", revision]);
    expectRpc(["set", { content, expectedRevision: Number(revision) }]);
  });

  it("reports revision conflicts without rereading or retrying", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: false, currentRevision: 43 });
    await expectFailure(
      ["--unset", "--expected-revision", "42"],
      "cron scratch changed concurrently (current revision 43)",
    );
    expectRpc(["set", { content: null, expectedRevision: 42 }]);
  });

  it.each([
    ["invalid revision", ["--set", "x", "--expected-revision", "invalid"]],
    ["file input", ["--file", "missing-scratch-file", "--expected-revision", "42"]],
    [
      "oversized inline input",
      ["--set", "x".repeat(CRON_JOB_SCRATCH_MAX_BYTES + 1), "--expected-revision", "42"],
    ],
  ])("reports Gateway errors before consuming %s", async (_label, args) => {
    callGatewayFromCli.mockRejectedValue(new Error("Gateway unavailable"));
    await expectFailure(args, "Gateway unavailable");
    expectRpc(["get", {}]);
  });
});
