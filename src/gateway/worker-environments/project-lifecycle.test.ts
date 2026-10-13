import { EventEmitter } from "node:events";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../../process/exec.js";
import type { EnvironmentRecipe } from "./environment-recipe.js";
import { runWorkerProjectLifecycle } from "./project-setup-script.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";

function lifecycleTransport(failExecutable?: string) {
  const events: string[] = [];
  const killedGroups: number[] = [];
  const invocations: {
    executable: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  const tunnel: Pick<WorkerTunnelHandle, "runWorkspaceCommand"> = {
    runWorkspaceCommand: vi.fn(async (command): Promise<SpawnResult> => {
      command.assertCurrent?.();
      const process = Object.assign(new EventEmitter(), {
        env: { PATH: "/worker/bin", HOME: "/worker/home", PRIVATE_FIXTURE: "not inherited" },
        cwd: () => "/worker/project",
        kill: vi.fn((pid: number) => killedGroups.push(pid)),
        exitCode: 0,
      });
      let stderr = "";
      const spawn = (
        executable: string,
        args: string[],
        options: { cwd: string; env: Record<string, string> },
      ) => {
        invocations.push({ executable, args, cwd: options.cwd, env: options.env });
        events.push(`spawn:${executable}`);
        const child = Object.assign(new EventEmitter(), {
          pid: 123,
          stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
        });
        queueMicrotask(() => {
          const code = executable === failExecutable ? 1 : 0;
          if (code) {
            child.stderr.emit("data", Buffer.from("declared lifecycle failure"));
          }
          events.push(`close:${executable}`);
          child.emit("exit", code);
          child.emit("close", code);
        });
        return child;
      };
      await vm.runInNewContext(command.argv[2]!, {
        Buffer,
        process,
        require: () => ({ spawn }),
        performance: { now: () => 0 },
        setTimeout: vi.fn(),
        clearTimeout: vi.fn(),
        console: {
          error: (message: string) => {
            stderr = message;
          },
        },
      });
      return {
        stdout: "",
        stderr,
        code: process.exitCode,
        signal: null,
        killed: false,
        termination: "exit",
      };
    }),
  };
  return { tunnel, events, invocations, killedGroups };
}

const recipe: EnvironmentRecipe = {
  source: "devcontainer",
  identity: "a".repeat(40),
  inputs: { ".devcontainer/devcontainer.json": "a".repeat(40) },
  env: { LANG: null, MODE: "development", LITERAL: "${localEnv:EXAMPLE}" },
  postCreate: {
    lint: ["lint", "argument;with spaces"],
    build: "compile && generate",
  },
  postStart: ["serve", "--foreground"],
};

describe("cloud project lifecycle command transport", () => {
  it("runs parallel creation commands with spec command forms before start at the bound workspace", async () => {
    const { tunnel, events, invocations, killedGroups } = lifecycleTransport();

    await runWorkerProjectLifecycle({ recipe, tunnel, postCreate: true, assertCurrent: () => {} });

    expect(killedGroups).toEqual([]);
    expect(events).toEqual([
      "spawn:lint",
      "spawn:/bin/sh",
      "close:lint",
      "close:/bin/sh",
      "spawn:serve",
      "close:serve",
    ]);
    expect(invocations.map(({ executable, args }) => ({ executable, args }))).toEqual([
      { executable: "lint", args: ["argument;with spaces"] },
      { executable: "/bin/sh", args: ["-c", "compile && generate"] },
      { executable: "serve", args: ["--foreground"] },
    ]);
    for (const invocation of invocations) {
      expect(invocation.cwd).toBe("/worker/project");
      expect(invocation.env).toEqual({
        PATH: "/worker/bin",
        HOME: "/worker/home",
        MODE: "development",
        LITERAL: "${localEnv:EXAMPLE}",
        OPENCLAW_SOURCE_TREE_PATH: "/worker/project",
        OPENCLAW_WORKTREE_PATH: "/worker/project",
      });
    }
  });

  it("runs postStart without repeating postCreate for an already activated worker", async () => {
    const { tunnel, events } = lifecycleTransport();

    await runWorkerProjectLifecycle({ recipe, tunnel, postCreate: false, assertCurrent: () => {} });

    expect(events).toEqual(["spawn:serve", "close:serve"]);
  });

  it("settles every parallel command and reports failure before starting the next phase", async () => {
    const { tunnel, events } = lifecycleTransport("lint");

    await expect(
      runWorkerProjectLifecycle({
        recipe,
        tunnel,
        postCreate: true,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("declared lifecycle failure");

    expect(events).toEqual(["spawn:lint", "spawn:/bin/sh", "close:lint", "close:/bin/sh"]);
  });
});
