import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { appendGitConfig } from "../../infra/git-maintenance-env.js";

const requireModule = createRequire(import.meta.url);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const origin = "https://example.invalid/repository.git";
const token = "synthetic-worker-token";
let createRepository: typeof import("./node-worker-repository-preparation.js").createNodeWorkerRepositoryPreparation;
let createSetupScript: typeof import("./project-setup-script.js").createProjectSetupScript;

beforeAll(async () => {
  // AOT functions have opaque source even though calling them still works.
  const originalSource = Object.getOwnPropertyDescriptor(appendGitConfig, "toString");
  Object.defineProperty(appendGitConfig, "toString", {
    configurable: true,
    value: () => "function appendGitConfig() { [native code] }",
  });
  try {
    ({ createNodeWorkerRepositoryPreparation: createRepository } =
      await import("./node-worker-repository-preparation.js"));
    ({ createProjectSetupScript: createSetupScript } = await import("./project-setup-script.js"));
  } finally {
    if (originalSource) {
      Object.defineProperty(appendGitConfig, "toString", originalSource);
    } else {
      Reflect.deleteProperty(appendGitConfig, "toString");
    }
  }
});

const maintenance = {
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};

it.each(["win32", "linux", "darwin"] as const)(
  "runs opaque-source authenticated Git scripts and scrubs inherited credentials on %s",
  async (platform) => {
    for (const gitToken of [token, undefined]) {
      const spawnSync = vi.fn(() => ({ status: 1 }));
      const repository = createRepository(async ({ argv, input, seed }) => {
        if (!seed) {
          const gitArgs = argv.slice(4);
          runInNewContext(argv[2]!, {
            Buffer,
            process: {
              platform,
              argv: ["node", ...gitArgs],
              env: {
                PATH: "guest-tools",
                Git_CONFIG_COUNT: "1",
                GIT_CONFIG_VALUE_0: "inherited-secret",
                GH_TOKEN: "inherited-token",
                GITHUB_TOKEN: "inherited-token",
              },
              exitCode: 0,
            },
            require: (id: string) => {
              if (id === "node:fs") {
                return { readFileSync: () => input };
              }
              if (id === "node:child_process") {
                return { spawnSync };
              }
              throw new Error(`Unexpected guest import ${id}`);
            },
          });
          expect(spawnSync).toHaveBeenCalledExactlyOnceWith(
            "git",
            platform === "win32" ? ["-c", "core.longpaths=true", ...gitArgs] : gitArgs,
            {
              stdio: ["ignore", "inherit", "inherit"],
              env: {
                PATH: "guest-tools",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
                GIT_TERMINAL_PROMPT: "0",
                GIT_ASKPASS: "",
                SSH_ASKPASS: "",
                ...maintenance,
                GIT_CONFIG_COUNT: gitToken ? "3" : "2",
                ...(gitToken
                  ? {
                      GIT_CONFIG_KEY_2: `http.${origin}.extraheader`,
                      GIT_CONFIG_VALUE_2: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
                    }
                  : {}),
              },
            },
          );
          expect(argv.join(" ")).not.toContain(token);
        }
        return {
          code: seed ? 0 : 1,
          stdout: "absent",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
          workspaceDir: "/node/workspace",
        };
      });
      await expect(repository.prepareRepository({ origin, gitToken })).resolves.toMatchObject({
        kind: "failed",
        reason: "clone-failed",
      });
    }
  },
);

it("runs opaque-source project setup with worker-local Git isolation", async () => {
  const home = await fs.realpath(tempDirs.make("worker-git-script-"));
  await fs.mkdir(path.join(home, ".openclaw-worker", "git-seeds", "gateway", "seed", ".git"), {
    recursive: true,
  });
  const script = createSetupScript({
    namespace: "gateway",
    seedKey: "seed",
    preparationKey: "preparation",
    cacheKey: "cache",
    baseCommit: "a".repeat(40),
  });
  const source = script.slice(script.indexOf("\n", script.indexOf("node <<'PROJECT_")) + 1);
  let failure = "";
  const spawnSync = vi.fn(() => ({ status: 1, stdout: "", stderr: "" }));
  await runInNewContext(source.slice(0, source.lastIndexOf("\n")), {
    Buffer,
    performance,
    process: {
      env: { PATH: "worker-tools", HOME: home, GH_TOKEN: "unrelated-token" },
      umask: () => {},
      exitCode: 0,
      stdout: { write: () => {} },
    },
    console: { error: (message: string) => (failure = message) },
    require: (id: string) => {
      if (id === "node:child_process") {
        return { spawnSync };
      }
      if (id === "node:os") {
        return { homedir: () => home, devNull: "worker-null-device" };
      }
      return requireModule(id);
    },
  });
  expect(failure).toBe("Prepared project Git verification failed (git rev-parse: exit 1)");
  expect(spawnSync).toHaveBeenCalledExactlyOnceWith(
    "git",
    [
      "-C",
      path.join(home, ".openclaw-worker", "git-seeds", "gateway", "seed"),
      "rev-parse",
      "HEAD",
    ],
    {
      env: {
        PATH: "worker-tools",
        HOME: home,
        LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "worker-null-device",
        ...maintenance,
        GIT_CONFIG_KEY_2: "core.hooksPath",
        GIT_CONFIG_VALUE_2: "worker-null-device",
        GIT_CONFIG_KEY_3: "core.fsmonitor",
        GIT_CONFIG_VALUE_3: "false",
        GIT_CONFIG_COUNT: "4",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
      },
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 262144,
    },
  );
});
