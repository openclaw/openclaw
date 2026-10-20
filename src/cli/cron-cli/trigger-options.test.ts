import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
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

function expectRequest(method: string, options: unknown, payload: unknown) {
  expect(callGatewayFromCli).toHaveBeenCalledWith(method, options, payload);
}

async function run(operation: "add" | "edit", options: Record<string, string | true>) {
  const program = new Command().exitOverride();
  if (operation === "add") {
    registerCronAddCommand(program);
  } else {
    registerCronEditCommand(program);
  }
  const prefix = operation === "add" ? ["add"] : ["edit", "job-1"];
  const values = operation === "add" ? { name: "watcher", every: "30s", ...options } : options;
  const args = Object.entries(values).flatMap(([key, value]) =>
    value === true ? [`--${key}`] : [`--${key}`, value],
  );
  await program.parseAsync([...prefix, ...args], { from: "user" });
}

async function rejectAdd(options: Record<string, string | true>, message: string) {
  const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  try {
    await expect(run("add", options)).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
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
      expect.objectContaining({ triggerScript: scriptPath, triggerOnce: true }),
      expect.objectContaining({ trigger: { script: "json({ fire: true })", once: true } }),
    );
  });

  it("rejects an explicitly blank trigger script before adding a job", async () => {
    await rejectAdd(
      { "trigger-script": "   ", "system-event": "changed", session: "main" },
      "--trigger-script must not be blank",
    );
  });

  it("reads the exact payload path and budgets on add", async () => {
    const scriptPath = await fixture("job.js ", "  return { notify: 'done' }  \n");
    await run("add", {
      name: "script job",
      script: scriptPath,
      "script-timeout-seconds": "450",
      "script-tool-budget": "75",
      session: "isolated",
    });

    expectRequest(
      "cron.add",
      expect.objectContaining({
        script: scriptPath,
        scriptTimeoutSeconds: "450",
        scriptToolBudget: "75",
      }),
      expect.objectContaining({
        sessionTarget: "isolated",
        payload: {
          kind: "script",
          script: "return { notify: 'done' }",
          timeoutSeconds: 450,
          toolBudget: 75,
        },
      }),
    );
  });

  it("rejects script creation with a generic timeout", async () => {
    const scriptPath = await fixture("job.js", "return { notify: 'done' }");
    await rejectAdd(
      { name: "script job", script: scriptPath, "timeout-seconds": "30" },
      "Use --script-timeout-seconds for script jobs, not --timeout-seconds.",
    );
  });

  it("reads the exact payload path on edit", async () => {
    const scriptPath = await fixture("edit-job.js ", "return { state: { ok: true } }\n");
    await run("edit", {
      script: scriptPath,
      "script-timeout-seconds": "600",
      "script-tool-budget": "100",
    });

    expectRequest("cron.update", expect.objectContaining({ script: scriptPath }), {
      id: "job-1",
      patch: {
        payload: {
          kind: "script",
          script: "return { state: { ok: true } }",
          timeoutSeconds: 600,
          toolBudget: 100,
        },
      },
    });
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

    expectRequest(
      "cron.add",
      expect.anything(),
      expect.objectContaining({ pacing: { min: "15m", max: "4h" } }),
    );
  });

  it.each([
    ["trigger", "clearTrigger"],
    ["pacing", "clearPacing"],
  ])("maps --clear-%s to a nullable edit patch", async (field, option) => {
    await run("edit", { [`clear-${field}`]: true });
    expectRequest("cron.update", expect.objectContaining({ [option]: true }), {
      id: "job-1",
      patch: { [field]: null },
    });
  });
});
