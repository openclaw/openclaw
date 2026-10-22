import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return { ...actual, callGatewayFromCli };
});

const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");
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
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
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
