import { expect, it, vi } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

// mock-isolation: Capture validation diagnostics without writing to the CLI runtime.
vi.mock("../runtime.js", () => ({ defaultRuntime: { log: vi.fn(), error: vi.fn() } }));

const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: { dbPath: { type: "string" } },
};

function manifest(id: string, kind?: string) {
  return {
    id,
    ...(kind ? { kind } : {}),
    origin: "global",
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    rootDir: `/tmp/plugins/${id}`,
    source: "test",
    manifestPath: `/tmp/plugins/${id}/openclaw.plugin.json`,
    schemaCacheKey: `test:${id}`,
    configSchema,
  };
}

const pluginMetadataSnapshot = {
  manifestRegistry: {
    plugins: [
      manifest("memory-fusion", "memory"),
      manifest("memory-store", "memory"),
      manifest("notes"),
    ],
    diagnostics: [],
  },
};

function validate(plugins: Record<string, unknown>) {
  return validateConfigObjectWithPlugins({ plugins }, {
    pluginMetadataSnapshot,
  } as Parameters<typeof validateConfigObjectWithPlugins>[1]);
}

const disabledWarning = {
  path: "plugins.entries.memory-store",
  message: expect.stringContaining("but config is present"),
};

it("validates a memory backend's config as a loaded plugin", () => {
  const invalid = validate({
    slots: { memory: "memory-fusion" },
    entries: { "memory-store": { memoryBackend: true, config: { dbPath: 1 } } },
  });
  expect(invalid.ok).toBe(false);

  const valid = validate({
    slots: { memory: "memory-fusion" },
    entries: { "memory-store": { memoryBackend: true, config: { dbPath: "store.db" } } },
  });
  expect(valid.ok).toBe(true);
  expect(valid.warnings).not.toContainEqual(expect.objectContaining(disabledWarning));

  const withoutOptIn = validate({
    slots: { memory: "memory-fusion" },
    entries: { "memory-store": { config: { dbPath: "store.db" } } },
  });
  expect(withoutOptIn.warnings).toContainEqual(expect.objectContaining(disabledWarning));
});

it.each([
  ["memory-fusion", "memory-fusion", "owns plugins.slots.memory"],
  ["memory-store", "none", 'plugins.slots.memory is "none"'],
  ["notes", "memory-fusion", "not a memory plugin"],
])("warns that memoryBackend on %s has no effect (slot %s)", (id, slot, reason) => {
  const result = validate({ slots: { memory: slot }, entries: { [id]: { memoryBackend: true } } });
  expect(result.warnings).toContainEqual({
    path: `plugins.entries.${id}.memoryBackend`,
    message: expect.stringContaining(reason),
  });
});
