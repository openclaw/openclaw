import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as ImmutableInstallModule from "../../infra/update-immutable-install.js";
import { defaultRuntime } from "../../runtime.js";
import { createTempHomeEnv } from "../../test-utils/temp-home.js";
import type { TempHomeEnv } from "../../test-utils/temp-home.js";
import { resolvePrefix } from "../../update/store.js";
import type * as OneShotExitModule from "../one-shot-exit.js";
import * as shared from "./shared.js";
import { tryRunImmutableUpdateCommand } from "./update-command-immutable.js";

const { prepare, inspection } = vi.hoisted(() => {
  const inspectFixture = (
    root: string,
  ): ImmutableInstallModule.ImmutableUpdateResult["installation"] => ({
    root,
    currentSha: "a".repeat(40),
    currentPath: `${root}/generations/current`,
    activationEnabled: true,
  });
  return {
    inspection: inspectFixture,
    prepare: vi.fn<typeof ImmutableInstallModule.prepareImmutableUpdate>(
      async ({ root, dryRun }) => {
        if (!dryRun) {
          throw new Error("The immutable executor was reached");
        }
        return { status: "dry-run", installation: inspectFixture(root), steps: [], warnings: [] };
      },
    ),
  };
});
vi.mock("../../infra/update-immutable-install.js", async (original) => ({
  ...(await original<typeof ImmutableInstallModule>()),
  inspectImmutableInstall: async (root: string) => inspection(root),
  prepareImmutableUpdate: prepare,
  adoptImmutableInstall: vi.fn(),
}));
vi.mock("../one-shot-exit.js", async (original) => ({
  ...(await original<typeof OneShotExitModule>()),
  exitCliAfterOutput: (_runtime: unknown, code: number): never => {
    throw new Error(`exit ${code}`);
  },
}));
let home: TempHomeEnv;
beforeEach(async () => {
  home = await createTempHomeEnv("immutable-release-owner-");
  prepare.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await home.restore();
});

it.each([false, true])(
  "previews but does not activate a converted immutable installation, dryRun=%s",
  async (dryRun) => {
    const prefix = resolvePrefix();
    const root = path.join(prefix, "releases/selected/openclaw");
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(root, path.join(prefix, "openclaw"), "junction");
    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    if (dryRun) {
      await expect(tryRunImmutableUpdateCommand({ dryRun, json: true })).resolves.toBe(true);
      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ root, dryRun: true }));
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "dry-run",
          activation: "planned",
          message: "Inspection only; no generation was prepared or activated.",
        }),
      );
      expect(error).not.toHaveBeenCalled();
    } else {
      await expect(tryRunImmutableUpdateCommand({ dryRun })).rejects.toThrow("exit 1");
      expect(prepare).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("resident launcher"));
      expect(error).toHaveBeenCalledWith(expect.stringContaining("openclaw-launcher.mjs"));
    }
  },
);
