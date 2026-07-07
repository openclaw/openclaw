// Tests for the Claws CLI inspection and read-only plan commands.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn((value: unknown) => errors.push(String(value))),
    writeJson: vi.fn((value: unknown, space = 2) =>
      logs.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    ),
    writeStdout: vi.fn((value: string) =>
      logs.push(value.endsWith("\n") ? value.slice(0, -1) : value),
    ),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return { logs, errors, runtime };
});

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

const { registerClawsCli } = await import("./claws-cli.js");

async function writeManifest(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-"));
  const path = join(dir, "claw.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

async function runCli(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerClawsCli(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
      throw error;
    }
  }
}

describe("claws cli", () => {
  beforeEach(() => {
    mocks.logs.length = 0;
    mocks.errors.length = 0;
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
  });

  it("prints JSON inspection for a local claw manifest", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [
        {
          kind: "plugin",
          id: "example-plugin",
          selector: "npm:@openclaw/plugin-example@1.0.0",
        },
      ],
    });

    await runCli(["claws", "inspect", manifestPath, "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      valid: true,
      manifest: {
        id: "starter",
        entries: [{ kind: "plugin", required: true }],
      },
    });
  });

  it("builds a read-only JSON plan", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [
        {
          kind: "workspaceFile",
          id: "soul",
          path: "SOUL.md",
          source: "files/SOUL.md",
        },
      ],
    });

    await runCli(["claws", "plan", manifestPath, "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      schemaVersion: "openclaw.clawPlan.v1",
      readOnly: true,
      summary: { totalEntries: 1, requiresConsent: 1 },
      entries: [{ id: "soul", decision: "requiresConsent" }],
    });
  });

  it("exits non-zero for invalid manifests", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [{ kind: "plugin", id: "missing-selector" }],
    });

    await runCli(["claws", "inspect", manifestPath]);

    expect(mocks.runtime.error).toHaveBeenCalled();
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });
});
