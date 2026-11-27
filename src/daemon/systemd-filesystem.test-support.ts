import { vi } from "vitest";

export async function mockSystemdFs(existsSync: typeof import("node:fs").existsSync) {
  const actual = await vi.importActual<
    typeof import("node:fs") & { default: typeof import("node:fs") }
  >("node:fs");
  const overrides = { existsSync };
  return { ...actual, ...overrides, default: { ...actual.default, ...overrides } };
}
