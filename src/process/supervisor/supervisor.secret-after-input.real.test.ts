import { afterEach, expect, it, vi } from "vitest";
import { getProcessSupervisor } from "./index.js";

afterEach(() => vi.unstubAllEnvs());

// A CLI run that writes its prompt to stdin after an async prepareInput (Claude CLI with an
// OpenClaw-held login) must still hand the child its credential on the secret descriptor.
it.skipIf(process.platform === "win32")(
  "delivers secret input after an async stdin prompt",
  { timeout: 15_000 },
  async () => {
    vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
    const reader = `
      const fs = require("node:fs");
      const prompt = fs.readFileSync(0, "utf8");
      const secret = fs.readFileSync(3, "utf8");
      process.stdout.write(prompt + "|" + secret);
    `;
    let stdout = "";
    const supervisor = getProcessSupervisor();
    const run = await supervisor.spawn({
      runId: "secret-after-input",
      mode: "child",
      argv: [process.execPath, "-e", reader],
      env: { PATH: "/usr/bin:/bin" },
      exactEnv: true,
      timeoutMs: 10_000,
      input: "prompt",
      prepareInput: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      },
      secretInput: { fd: 3, createData: () => Buffer.from("credential") },
      onStdout: (chunk) => {
        stdout += chunk;
      },
    });
    const exit = await run.wait();
    expect(exit.exitCode).toBe(0);
    expect(stdout).toBe("prompt|credential");
  },
);
