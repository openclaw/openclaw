import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { createTempHomeEnv } from "../../test-utils/temp-home.js";
import type { TempHomeEnv } from "../../test-utils/temp-home.js";
import { resolvePrefix } from "../../update/store.js";
import * as shared from "./shared.js";
import { tryRunImmutableUpdateCommand } from "./update-command-immutable.js";

const prepare = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("The immutable executor was reached");
  }),
);
vi.mock("../../infra/update-immutable-install.js", () => ({
  inspectImmutableInstall: async () => ({}),
  prepareImmutableUpdate: prepare,
  adoptImmutableInstall: vi.fn(),
}));
vi.mock("../one-shot-exit.js", () => ({
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
  "refuses immutable activation of a converted install, preview=%s",
  async (dryRun) => {
    const prefix = resolvePrefix();
    const root = path.join(prefix, "releases/selected/openclaw");
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(root, path.join(prefix, "openclaw"), "junction");
    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    await expect(tryRunImmutableUpdateCommand({ dryRun })).rejects.toThrow("exit 1");
    expect(prepare).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("resident launcher"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("openclaw-launcher.mjs"));
  },
);
