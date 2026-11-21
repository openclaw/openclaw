import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  resolvePluginInstallRoots,
  withPluginInstallRoots,
} from "../plugins/install-root-context.js";
import { resolveManagedResourceStateDir, resolveStateDir } from "./state-paths.js";

afterEach(() => vi.unstubAllEnvs());

it("keeps managed resources on the inherited root while run state is redirected", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", "/operator/openclaw");
  const roots = resolvePluginInstallRoots();
  vi.stubEnv("OPENCLAW_STATE_DIR", "/temporary/run");
  await withPluginInstallRoots(roots, async () => {
    expect(resolveManagedResourceStateDir()).toBe(path.resolve("/operator/openclaw"));
    expect(resolveStateDir()).toBe(path.resolve("/temporary/run"));
  });
  expect(resolveManagedResourceStateDir()).toBe(resolveStateDir());
});
