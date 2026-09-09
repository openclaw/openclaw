import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  readControlPlaneUpdateSentinelMeta,
} from "../../infra/update-control-plane-sentinel.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), root: vi.fn<() => Promise<string>>() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (command: string, args: string[], options: import("node:child_process").SpawnOptions) =>
      args[1] === "update"
        ? mocks.spawn(command, args, options)
        : original.spawn(command, args, options),
  };
});
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
}));
// This boundary test never inspects or changes an operator's service.
vi.mock("./update-command-service-plan.js", () => ({
  resolveManagedServicePackageUpdatePlan: async () => ({ rootRedirect: null }),
}));

import { continuePostCoreUpdateInFreshProcess } from "./update-command-post-core.js";
import { prepareUpdateCommand } from "./update-command-run.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("managed post-core root handoff", () => {
  it.each([false, true])(
    "binds pnpm replacement to the activated generation (foreign child=%s)",
    async (foreignChild) => {
      const state = await createOpenClawTestState({ label: "post-core-root" });
      try {
        await state.writeConfig({});
        const globalRoot = state.path("pnpm", "global", "5", "node_modules");
        const previous = path.join(
          globalRoot,
          ".pnpm",
          "openclaw@1.0.0",
          "node_modules",
          "openclaw",
        );
        const next = path.join(globalRoot, ".pnpm", "openclaw@2.0.0", "node_modules", "openclaw");
        const root = path.join(globalRoot, "openclaw");
        await writePackageRoot(previous, "1.0.0");
        await writePackageRoot(next, "2.0.0");
        await fs.symlink(previous, root, process.platform === "win32" ? "junction" : "dir");
        const meta = {
          root: await fs.realpath(root),
          handoffId: "fixture-handoff",
          runId: "fixture-run",
          serviceStoppedAtMs: 123,
          note: "Fixture update",
        };
        const metaPath = await state.writeJson("sentinel-meta.json", { version: 1, meta });
        await withEnvAsync({ [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath }, async () => {
          mocks.root.mockResolvedValue(root);
          await prepareUpdateCommand({ json: true });
          // pnpm keeps the global link name while replacing its versioned target.
          await fs.unlink(root);
          await fs.symlink(next, root, process.platform === "win32" ? "junction" : "dir");
          const foreign = state.path("different-install");
          await writePackageRoot(foreign, "2.0.0");
          mocks.root.mockResolvedValue(foreignChild ? foreign : root);
          let childError: unknown;
          let childMeta: Awaited<ReturnType<typeof readControlPlaneUpdateSentinelMeta>> = null;
          mocks.spawn.mockImplementation(
            (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
              const child = new EventEmitter();
              void withEnvAsync(options.env, async () => {
                childMeta = await readControlPlaneUpdateSentinelMeta();
                await prepareUpdateCommand({ json: true });
              }).then(
                () => child.emit("exit", 0, null),
                (error: unknown) => {
                  childError = error;
                  child.emit("exit", 1, null);
                },
              );
              return child;
            },
          );
          const result = await continuePostCoreUpdateInFreshProcess({
            root,
            channel: "stable",
            requestedChannel: null,
            opts: { json: true },
            pluginInstallRecords: {},
            updateStartedAtMs: 123,
            timeoutMs: 15_000,
          });
          if (foreignChild) {
            expect(String(childError)).toContain("Managed update handoff root mismatch");
            expect(result).toEqual({ resumed: false, exitCode: 1 });
          } else {
            expect(childError).toBeUndefined();
            expect(result).toEqual({ resumed: true });
          }
          expect(childMeta).toMatchObject({ ...meta, root: await fs.realpath(next) });
          expect(await readControlPlaneUpdateSentinelMeta()).toMatchObject(meta);
          expect(JSON.parse(await fs.readFile(metaPath, "utf8"))).toEqual({ version: 1, meta });
        });
      } finally {
        await state.cleanup();
      }
    },
  );
});
