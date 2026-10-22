import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi } from "./types.js";

export function createOwnershipHarness(
  id: string,
  overrides: Partial<Parameters<OpenClawPluginApi["registerAgentHarness"]>[0]> = {},
) {
  return {
    id,
    label: id,
    supports: () => ({ supported: true as const }),
    runAttempt: async () => {
      throw new Error("unused");
    },
    ...overrides,
  };
}

export function createOwnershipRecord(
  id: string,
  overrides: Partial<Parameters<typeof createPluginRecord>[0]> = {},
) {
  return createPluginRecord({
    id,
    source: `/plugins/${id}/index.js`,
    origin: "global",
    enabled: true,
    configSchema: false,
    ...overrides,
  });
}

export function createOwnershipRegistry(runtime: PluginRuntime, config: OpenClawConfig = {}) {
  const builder = createRuntimeTestRegistry(runtime);
  return {
    builder,
    createApi(this: void, id: string, overrides: Parameters<typeof createOwnershipRecord>[1] = {}) {
      const record = createOwnershipRecord(id, { origin: "bundled", ...overrides });
      return { record, api: builder.createApi(record, { config }) };
    },
  };
}
export function createOwnershipSubagent(runId: string, text = "completed") {
  return {
    complete: vi.fn(async () => ({ text })),
    forkSession: vi.fn(async () => ({ text })),
    run: vi.fn(async () => ({ runId })),
    waitForRun: vi.fn(async () => ({ status: "ok" as const })),
    getSessionMessages: vi.fn(async () => ({ messages: [] })),
    deleteSession: vi.fn(async () => {}),
  } satisfies PluginRuntime["subagent"];
}
