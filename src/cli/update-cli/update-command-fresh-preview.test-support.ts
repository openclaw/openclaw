import { vi } from "vitest";
import * as runtimePlan from "./update-command-runtime-preflight.js";

export function allowPackageRuntime() {
  return vi.spyOn(runtimePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
    ok: true,
    value: {},
  });
}

export function createStage(root: string) {
  return { root, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
}
