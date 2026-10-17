import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type * as commandExec from "../../process/exec.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService } from "./service.js";

export function useServiceFixture(
  initialize: (root: string) => Promise<string>,
  options: {
    prefix: string;
    snapshot?: boolean;
    mkdirState?: boolean;
    resetDatabase?: boolean;
    stateName?: string;
    now?: () => number;
    getConfig?: NonNullable<ConstructorParameters<typeof ManagedWorktreeService>[0]>["getConfig"];
  },
) {
  let service: ManagedWorktreeService;
  const fixture = {
    root: "",
    repo: "",
    stateDir: "",
    env: process.env,
    create(name: string): ReturnType<ManagedWorktreeService["create"]> {
      return service.create({ repoRoot: fixture.repo, name, baseRef: "HEAD" });
    },
    get service() {
      return service;
    },
    set service(value: ManagedWorktreeService) {
      service = value;
    },
  };
  beforeEach(async () => {
    fixture.root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), options.prefix));
    fixture.repo = await initialize(fixture.root);
    fixture.stateDir = path.join(fixture.root, options.stateName ?? "state");
    if (options.mkdirState) {
      await fs.mkdir(fixture.stateDir, { recursive: true });
    }
    fixture.env = { ...process.env, OPENCLAW_STATE_DIR: fixture.stateDir };
    if (options.snapshot) {
      setRuntimeConfigSnapshot({}, {});
    }
    service = new ManagedWorktreeService({
      env: fixture.env,
      now: options.now,
      getConfig: options.getConfig,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (options.snapshot) {
      resetConfigRuntimeState();
    }
    await closeOpenClawStateDatabaseAsync();
    if (options.resetDatabase !== false) {
      closeOpenClawStateDatabaseForTest();
    }
    await fs.rm(fixture.root, { recursive: true, force: true });
  });
  return fixture;
}

const execFileAsync = promisify(execFile);
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}
export async function initializeLocalRepository(root: string, template?: string) {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main", ...(template ? [`--template=${template}`] : []));
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  // Template copies must not race background maintenance.
  if (template) {
    await git(repo, "config", "maintenance.auto", "false");
  }
  await writeFile(repo, "README.md", "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return await fs.realpath(repo);
}
export const writeFile = (root: string, name: string, contents: string | Uint8Array) =>
  fs.writeFile(path.join(root, name), contents);

export async function expectFile(root: string, name: string, contents: string) {
  expect(await fs.readFile(path.join(root, name), "utf8")).toBe(contents);
}
export async function expectMissing(target: string) {
  await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
}
export function atGate<T>(
  gate: PromiseLike<T>,
  work: PromiseLike<unknown>,
  message: string,
  signal: AbortSignal,
) {
  return withinTest(awaitGateBeforeSettlement(gate, work, message), signal);
}
export function afterCommand(
  commands: Pick<typeof commandExec, "runCommandWithTimeout">,
  effect: (
    argv: Parameters<typeof commandExec.runCommandWithTimeout>[0],
    result: Awaited<ReturnType<typeof commandExec.runCommandWithTimeout>>,
  ) => Promise<void>,
) {
  const run = commands.runCommandWithTimeout;
  return vi.spyOn(commands, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
    const result = await run(argv, options);
    await effect(argv, result);
    return result;
  });
}
