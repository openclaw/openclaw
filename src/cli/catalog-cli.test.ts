import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";
import { registerCommandsCli } from "./catalog-cli.js";

const loadPluginCliDescriptorEntriesMock = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/cli-registry-loader.js").loadPluginCliDescriptorEntries>(
    async () => [],
  ),
);

vi.mock("../plugins/cli-registry-loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../plugins/cli-registry-loader.js")>();
  return {
    ...original,
    loadPluginCliDescriptorEntries: loadPluginCliDescriptorEntriesMock,
  };
});

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  registerCommandsCli(program);
  return program;
}

async function captureStdout(run: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
    return chunks.join("");
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe("commands cli", () => {
  afterEach(() => {
    loadPluginCliDescriptorEntriesMock.mockReset();
    loadPluginCliDescriptorEntriesMock.mockResolvedValue([]);
  });

  it("prints parent help for a bare commands invocation", async () => {
    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["node", "openclaw", "commands"]);
    });

    expect(output).toContain("list");
    expect(output).not.toContain("audit");
  });

  it("prints command inventory JSON", async () => {
    const output = await captureStdout(async () => {
      await createProgram().parseAsync(["node", "openclaw", "commands", "list", "--json"]);
    });
    const parsed = JSON.parse(output) as {
      counts: { commandDescriptors: number; routedOperations: number; runtimeCommands: number };
    };

    expect(parsed.counts.commandDescriptors).toBeGreaterThan(50);
    expect(parsed.counts.routedOperations).toBeGreaterThan(10);
    expect(parsed.counts.runtimeCommands).toBeGreaterThan(0);
  });

  it("loads plugin descriptors only when requested and keeps JSON clean", async () => {
    const forceStderrSnapshots: boolean[] = [];
    loadPluginCliDescriptorEntriesMock.mockImplementationOnce(async () => {
      forceStderrSnapshots.push(loggingState.forceConsoleToStderr);
      return [
        {
          pluginId: "example-plugin",
          parentPath: [],
          commands: ["example"],
          descriptors: [
            { name: "example", description: "Example plugin command", hasSubcommands: false },
          ],
        },
      ];
    });

    const output = await captureStdout(async () => {
      await createProgram().parseAsync([
        "node",
        "openclaw",
        "commands",
        "list",
        "--json",
        "--plugin-descriptors",
      ]);
    });

    expect(forceStderrSnapshots).toEqual([true]);
    expect(JSON.parse(output).counts.pluginCommands).toBe(1);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("routes plugin logs away from Markdown output", async () => {
    const forceStderrSnapshots: boolean[] = [];
    loadPluginCliDescriptorEntriesMock.mockImplementationOnce(async () => {
      forceStderrSnapshots.push(loggingState.forceConsoleToStderr);
      return [];
    });

    await captureStdout(async () => {
      await createProgram().parseAsync([
        "node",
        "openclaw",
        "commands",
        "list",
        "--markdown",
        "--plugin-descriptors",
      ]);
    });

    expect(forceStderrSnapshots).toEqual([true]);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });
});
