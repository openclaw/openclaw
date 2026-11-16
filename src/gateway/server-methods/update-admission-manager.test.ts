import fs from "node:fs/promises";
import path from "node:path";
import { it as baseIt, expect, vi } from "vitest";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import { pkgQueryResult } from "../../infra/update-freebsd-pkg-ownership.test-support.js";
import { SystemPackageOwnershipError } from "../../infra/update-system-package-ownership.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { resolveGatewayUpdateAdmission } from "./update-admission.js";

const mocks = vi.hoisted(() => ({
  root: "",
  command: vi.fn<typeof import("../../process/exec.js").runCommandWithTimeout>(),
  inventory: vi.fn<typeof import("../../process/exec.js").runCommandBuffered>(),
  phase: vi.fn(),
  step: vi.fn(),
}));

vi.mock("../../infra/openclaw-root.js", async (original) => ({
  ...(await original<typeof import("../../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => mocks.root,
}));
vi.mock("../../infra/restart-sentinel.js", async (original) => ({
  ...(await original<typeof import("../../infra/restart-sentinel.js")>()),
  readVerifiedGitUpdateReceipt: async () => null,
}));
vi.mock("../../infra/update-run-write.async.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-run-write.async.js")>()),
  recordUpdateRunPhaseAsync: mocks.phase,
  recordUpdateRunStepAsync: mocks.step,
}));
vi.mock("../../process/exec.js", async (original) => ({
  ...(await original<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout: mocks.command,
  runCommandBuffered: mocks.inventory,
}));

const it = baseIt.extend<{ fixture: { root: string; lifecycle: UpdateCheckLifecycle } }>({
  fixture: ({ task: _task }, use) =>
    withTestDir({ prefix: "openclaw-update-admission-manager-" }, async (base) => {
      const root = path.join(base, "lib", "node_modules", "openclaw");
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
      mocks.root = root;
      mocks.command.mockReset();
      mocks.inventory.mockReset().mockResolvedValue(pkgQueryResult());
      mocks.phase.mockClear();
      mocks.step.mockClear();
      await withEnvAsync(
        {
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          HOME: base,
          USERPROFILE: base,
          BUN_INSTALL: path.join(base, "bun"),
          NPM_CONFIG_GLOBALCONFIG: path.join(base, "npmrc"),
          NPM_CONFIG_USERCONFIG: path.join(base, "npmrc"),
        },
        async () => {
          const scheduler = createTestGatewayScheduler();
          const lifecycle = createGatewayUpdateLifecycle(scheduler);
          try {
            await use({ root, lifecycle });
          } finally {
            await lifecycle.stop();
            await scheduler.stop();
          }
        },
      );
    }),
});

function answerRootProbes(manager: "npm" | "pnpm", timeoutMs?: number) {
  mocks.command.mockImplementation(async (argv, options) => {
    const budget = typeof options === "number" ? options : options.timeoutMs;
    const available = argv[1] === "root" && (timeoutMs === undefined || budget === timeoutMs);
    return {
      stdout: available
        ? `${argv[0] === manager ? path.dirname(mocks.root) : path.join(mocks.root, "foreign")}\n`
        : "",
      stderr: "",
      code: available ? 0 : 1,
      signal: null,
      killed: false,
      termination: "exit",
    };
  });
}

function rootProbes() {
  return mocks.command.mock.calls
    .filter(([argv]) => argv[1] === "root")
    .map(([argv, options]) => [argv[0], typeof options === "number" ? options : options.timeoutMs]);
}

it.for(["npm", "pnpm"] as const)(
  "reuses fresh %s ownership after one discovery",
  async (manager, { fixture: { root, lifecycle } }) => {
    lifecycle.installStatus = {
      root,
      status: { root, installKind: "package", packageManager: "bun" },
      installReceipt: null,
    };
    answerRootProbes(manager);

    await expect(resolveGatewayUpdateAdmission("run")).resolves.toMatchObject({
      status: { packageManager: manager },
      installSurface: { kind: "global", mode: manager, root, packageRoot: root },
    });

    expect(rootProbes().map(([name]) => name)).toEqual(
      manager === "npm" ? ["npm"] : ["npm", "pnpm"],
    );
    expect(mocks.phase).toHaveBeenLastCalledWith("run", "requested", {
      target: { installationMethod: `${manager}-global` },
      step: { step: "installation-inspection", status: "completed" },
    });
  },
);

it("retries unknown ownership with the requested interactive budget", async ({
  fixture: { root },
}) => {
  answerRootProbes("pnpm", 120_000);

  await expect(resolveGatewayUpdateAdmission("run", 120_000)).resolves.toMatchObject({
    status: { packageManager: "unknown" },
    installSurface: { kind: "global", mode: "pnpm", root },
  });
  expect(rootProbes()).toEqual([
    ["npm", expect.any(Number)],
    ["pnpm", expect.any(Number)],
    ["npm", 120_000],
    ["pnpm", 120_000],
  ]);
});

it("checks native package ownership after successful manager discovery", async ({
  fixture: { root },
}) => {
  answerRootProbes("npm");
  mocks.inventory.mockResolvedValue(pkgQueryResult(`${path.join(root, "package.json")}\n`));

  await withMockedPlatform("freebsd", async () => {
    await expect(resolveGatewayUpdateAdmission("run")).rejects.toBeInstanceOf(
      SystemPackageOwnershipError,
    );
  });
  expect(rootProbes().map(([name]) => name)).toEqual(["npm"]);
  expect(mocks.inventory).toHaveBeenCalledOnce();
  expect(mocks.phase).not.toHaveBeenCalledWith(
    "run",
    "requested",
    expect.objectContaining({
      step: { step: "installation-inspection", status: "completed" },
    }),
  );
});
