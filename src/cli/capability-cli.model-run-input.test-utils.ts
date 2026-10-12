import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCap, runCapability } from "./capability-cli.test-harness.js";

export function registerModelRunInputTests({
  tempDirs,
  firstCompletionCall,
  firstGatewayCall,
  firstJsonOutput,
  expectRuntimeErrorContains,
  expectInvalidNoDispatch,
}: {
  tempDirs: { make(prefix: string): string };
  firstCompletionCall: () =>
    | {
        context?: { messages?: Array<{ content?: unknown }> };
        options?: { maxTokens?: unknown; temperature?: unknown };
      }
    | undefined;
  firstGatewayCall: () => { params?: Record<string, unknown> } | undefined;
  firstJsonOutput: () => Record<string, unknown> | undefined;
  expectRuntimeErrorContains: (message: string) => void;
  expectInvalidNoDispatch: () => void;
}): void {
  const runModelProbe = (...args: string[]) =>
    runCapability("model", "run", "--prompt", "hello", ...args, "--json");
  describe.runIf(process.platform !== "win32")("POSIX prompt files", () => {
    it("reads private model prompts from a mode-0600 prompt file", async () => {
      const tempDir = tempDirs.make("openclaw-model-run-prompt-");
      const promptFile = path.join(tempDir, "prompt.txt");
      await fs.writeFile(promptFile, "private prompt", { mode: 0o600 });

      try {
        await runCap("capability", "model", "run", "--prompt-file", promptFile, "--json");

        expect(firstCompletionCall()?.context?.messages?.[0]?.content).toBe("private prompt");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects prompt text combined with a prompt file", async () => {
      const tempDir = tempDirs.make("openclaw-model-run-prompt-");
      const promptFile = path.join(tempDir, "prompt.txt");
      await fs.writeFile(promptFile, "private prompt", { mode: 0o600 });

      try {
        await expect(
          runCap(
            "capability",
            "model",
            "run",
            "--prompt",
            "argv prompt",
            "--prompt-file",
            promptFile,
            "--json",
          ),
        ).rejects.toThrow("exit 1");

        expectRuntimeErrorContains("Use exactly one of --prompt or --prompt-file.");
        expectInvalidNoDispatch();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it.each([
      {
        name: "group-readable file",
        setup: async (tempDir: string) => {
          const promptFile = path.join(tempDir, "prompt.txt");
          await fs.writeFile(promptFile, "private prompt", { mode: 0o600 });
          await fs.chmod(promptFile, 0o640);
          return promptFile;
        },
        expected: "must have mode 0600",
      },
      {
        name: "symbolic link",
        setup: async (tempDir: string) => {
          const target = path.join(tempDir, "target.txt");
          const promptFile = path.join(tempDir, "prompt.txt");
          await fs.writeFile(target, "private prompt", { mode: 0o600 });
          await fs.symlink(target, promptFile);
          return promptFile;
        },
        expected: "must not be a symbolic link",
      },
      {
        name: "empty file",
        setup: async (tempDir: string) => {
          const promptFile = path.join(tempDir, "prompt.txt");
          await fs.writeFile(promptFile, "", { mode: 0o600 });
          return promptFile;
        },
        expected: "cannot be empty",
      },
      {
        name: "oversized file",
        setup: async (tempDir: string) => {
          const promptFile = path.join(tempDir, "prompt.txt");
          await fs.writeFile(promptFile, Buffer.alloc(1024 * 1024 + 1, 0x61), { mode: 0o600 });
          return promptFile;
        },
        expected: "must not exceed 1048576 bytes",
      },
    ])("rejects an unsafe $name prompt input", async ({ setup, expected }) => {
      const tempDir = tempDirs.make("openclaw-model-run-prompt-");
      try {
        const promptFile = await setup(tempDir);
        await expect(
          runCap("capability", "model", "run", "--prompt-file", promptFile, "--json"),
        ).rejects.toThrow("exit 1");

        expectRuntimeErrorContains(expected);
        expectInvalidNoDispatch();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("bounds reads when a prompt file grows after its initial stat", async () => {
      const tempDir = tempDirs.make("openclaw-model-run-prompt-");
      const promptFile = path.join(tempDir, "prompt.txt");
      await fs.writeFile(promptFile, Buffer.alloc(1024 * 1024 + 1, 0x61), { mode: 0o600 });
      const currentStat = await fs.lstat(promptFile);
      vi.spyOn(fs, "lstat").mockResolvedValueOnce(
        new Proxy(currentStat, {
          get(target, property, receiver) {
            return property === "size" ? 1 : Reflect.get(target, property, receiver);
          },
        }),
      );

      await expect(
        runCap("capability", "model", "run", "--prompt-file", promptFile, "--json"),
      ).rejects.toThrow("exit 1");

      expectRuntimeErrorContains("must not exceed 1048576 bytes");
      expectInvalidNoDispatch();
    });
  });

  it.runIf(process.platform === "win32")(
    "rejects prompt files on Windows before model execution",
    async () => {
      await expect(
        runCap("capability", "model", "run", "--prompt-file", "prompt.txt", "--json"),
      ).rejects.toThrow("exit 1");

      expectRuntimeErrorContains("--prompt-file is supported only on POSIX hosts.");
      expectInvalidNoDispatch();
    },
  );

  it("applies and reports requested local model-run overrides", async () => {
    await runCap(
      "capability",
      "model",
      "run",
      "--prompt",
      "hello",
      "--max-output-tokens",
      "64",
      "--temperature",
      "0",
      "--json",
    );

    expect(firstCompletionCall()?.options).toMatchObject({ maxTokens: 64, temperature: 0 });
    expect(firstJsonOutput()?.requestedOverrides).toEqual({ maxOutputTokens: 64, temperature: 0 });
  });

  it("propagates and reports requested gateway model-run overrides", async () => {
    await runCap(
      "capability",
      "model",
      "run",
      "--prompt",
      "hello",
      "--gateway",
      "--max-output-tokens",
      "64",
      "--temperature",
      "0",
      "--json",
    );

    expect(firstGatewayCall()?.params?.modelRunRequestedOverrides).toEqual({
      maxTokens: 64,
      temperature: 0,
    });
    expect(firstJsonOutput()?.requestedOverrides).toEqual({ maxOutputTokens: 64, temperature: 0 });
  });

  it("omits generation overrides from gateway requests when none were requested", async () => {
    await runCap("capability", "model", "run", "--prompt", "hello", "--gateway", "--json");

    expect(firstGatewayCall()?.params).not.toHaveProperty("modelRunRequestedOverrides");
  });

  it.each([
    { args: ["--prompt", "\n\t"], error: "--prompt cannot be empty or whitespace-only." },
    {
      args: ["--model", "not-a-provider/"],
      error: "Model overrides must use the form <provider/model>.",
    },
    { args: ["--thinking", "turbo-mode"], error: "Invalid thinking level." },
  ])("rejects invalid model run options $args before dispatch", async ({ args, error }) => {
    await expect(runModelProbe(...args)).rejects.toThrow("exit 1");
    expectRuntimeErrorContains(error);
    expectInvalidNoDispatch();
  });
}
