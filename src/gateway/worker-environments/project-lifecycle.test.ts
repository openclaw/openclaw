import { EventEmitter } from "node:events";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider } from "../../plugins/capability-provider.types.js";
import type { SpawnResult } from "../../process/exec.js";
import { result as spawnResult } from "./bootstrap.test-support.js";
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
      return spawnResult({ stderr, code: process.exitCode });
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

function runLifecycle(
  tunnel: Pick<WorkerTunnelHandle, "runWorkspaceCommand">,
  overrides: Partial<Parameters<typeof runWorkerProjectLifecycle>[0]> = {},
) {
  return runWorkerProjectLifecycle({
    recipe,
    tunnel,
    postCreate: true,
    assertCurrent: () => {},
    ...overrides,
  });
}

const boundWorkspace = { workspaceDir: "/worker/project", homeDir: "/worker/home" };

describe("cloud project lifecycle command transport", () => {
  it("runs parallel creation commands with spec command forms before start at the bound workspace", async () => {
    const { tunnel, events, invocations, killedGroups } = lifecycleTransport();

    await runLifecycle(tunnel);

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
    for (const { cwd, env } of invocations) {
      expect(cwd).toBe("/worker/project");
      expect(env).toEqual({
        PATH: "/worker/bin",
        HOME: "/worker/home",
        MODE: "development",
        LITERAL: "${localEnv:EXAMPLE}",
        OPENCLAW_SOURCE_TREE_PATH: "/worker/project",
        OPENCLAW_WORKTREE_PATH: "/worker/project",
      });
    }
  });

  it("uses the provider lease runner and passes protected environment after recipe values", async () => {
    const { tunnel, invocations } = lifecycleTransport();
    const provider = vi.fn(
      async (command: Parameters<NonNullable<WorkerProvider["runSetupCommand"]>>[1]) => {
        command.assertCurrent();
        expect(command).toMatchObject(boundWorkspace);
        return tunnel.runWorkspaceCommand({
          argv: [
            "node",
            "-e",
            command.createScript({
              TOKEN: "sentinel_fixture",
              HTTPS_PROXY: "http://127.0.0.1:3131",
              NODE_EXTRA_CA_CERTS: "/tmp/owned/ca.pem",
            }),
          ],
          transportRetry: "never",
        });
      },
    );
    await runLifecycle(tunnel, {
      recipe: { ...recipe, env: { ...recipe.env, TOKEN: null, HTTPS_PROXY: "untrusted" } },
      ...boundWorkspace,
      runSetupCommand: provider,
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(tunnel.runWorkspaceCommand).toHaveBeenCalledTimes(1);
    for (const invocation of invocations) {
      expect(invocation.env).toMatchObject({
        TOKEN: "sentinel_fixture",
        HTTPS_PROXY: "http://127.0.0.1:3131",
        NODE_EXTRA_CA_CERTS: "/tmp/owned/ca.pem",
      });
      expect(invocation.env).not.toHaveProperty("PRIVATE_FIXTURE");
    }
  });

  it("keeps the ordinary tunnel when the provider has no protected setup transport", async () => {
    const { tunnel, events } = lifecycleTransport();
    await runLifecycle(tunnel, {
      postCreate: false,
      ...boundWorkspace,
      runSetupCommand: async () => undefined,
    });
    expect(tunnel.runWorkspaceCommand).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["spawn:serve", "close:serve"]);
  });

  it("does not fall back to the tunnel after a provider runner rejects", async () => {
    const { tunnel } = lifecycleTransport();
    await expect(
      runLifecycle(tunnel, {
        ...boundWorkspace,
        runSetupCommand: async () => {
          throw new Error("Protected setup egress is unavailable");
        },
      }),
    ).rejects.toThrow("Protected setup egress is unavailable");
    expect(tunnel.runWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("settles every parallel command and reports failure before starting the next phase", async () => {
    const { tunnel, events } = lifecycleTransport("lint");

    await expect(runLifecycle(tunnel)).rejects.toThrow("declared lifecycle failure");

    expect(events).toEqual(["spawn:lint", "spawn:/bin/sh", "close:lint", "close:/bin/sh"]);
  });
});
