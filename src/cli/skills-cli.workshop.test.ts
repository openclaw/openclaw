import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { registerSkillsCli } from "./skills-cli.js";

const tempDirs = createTrackedTempDirs();

const mocks = vi.hoisted(() => {
  const runtimeStdout: string[] = [];
  const runtimeErrors: string[] = [];
  const defaultRuntime = {
    log: vi.fn((message: string) => {
      runtimeStdout.push(message);
    }),
    error: vi.fn((message: string) => {
      runtimeErrors.push(message);
    }),
    writeStdout: vi.fn((value: string) => {
      runtimeStdout.push(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      runtimeStdout.push(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    defaultRuntime,
    runtimeStdout,
    runtimeErrors,
    workspaceDir: "",
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentIdByWorkspacePath: () => undefined,
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
}));

describe("skills workshop cli", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    return program;
  };

  const runCommand = async (argv: string[]) => {
    try {
      await createProgram().parseAsync(argv, { from: "user" });
    } catch (error) {
      if (error instanceof Error && error.message === "__exit__:0") {
        return;
      }
      throw error;
    }
  };

  beforeEach(async () => {
    mocks.workspaceDir = await tempDirs.make("openclaw-skills-cli-workshop-");
    mocks.runtimeStdout.length = 0;
    mocks.runtimeErrors.length = 0;
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.writeStdout.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.exit.mockClear();
  });

  afterEach(async () => {
    await tempDirs.cleanup();
  });

  it("creates, lists, inspects, and applies a skill proposal", async () => {
    const draftPath = path.join(mocks.workspaceDir, "draft.md");
    await fs.writeFile(
      draftPath,
      "# Paris Weather\n\nCheck current weather before advice.\n",
      "utf8",
    );

    await runCommand([
      "skills",
      "workshop",
      "propose-create",
      "--name",
      "Paris Weather",
      "--description",
      "Weather lookup workflow",
      "--proposal",
      draftPath,
    ]);

    const proposalId = mocks.runtimeStdout.at(-1);
    expect(proposalId).toMatch(/^paris-weather-/);

    await runCommand(["skills", "workshop", "list"]);
    expect(mocks.runtimeStdout.at(-1)).toContain(`${proposalId}  pending  create`);

    await runCommand(["skills", "workshop", "inspect", proposalId!]);
    expect(mocks.runtimeStdout.at(-1)).toContain("status: proposal");

    await runCommand(["skills", "workshop", "apply", proposalId!]);
    expect(mocks.runtimeStdout.at(-1)).toContain("Applied");
    await expect(
      fs.readFile(path.join(mocks.workspaceDir, "skills", "paris-weather", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Paris Weather");
  });

  it("rejects missing proposal drafts before creating workshop state", async () => {
    await expect(
      runCommand([
        "skills",
        "workshop",
        "propose-create",
        "--name",
        "Missing Draft",
        "--description",
        "Missing draft",
        "--proposal",
        path.join(mocks.workspaceDir, "missing.md"),
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.runtimeErrors[0]).toContain("file not found");
    await expect(
      fs.access(path.join(mocks.workspaceDir, ".openclaw", "skill-workshop")),
    ).rejects.toThrow();
  });
});
