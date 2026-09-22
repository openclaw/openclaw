import fs from "node:fs";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerConfigCli } from "../cli/config-cli.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as schemas from "../plugins/schema-validator.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as agentDirs from "./agent-dirs.js";
import * as metadata from "./io.plugin-metadata.js";
import type { OpenClawConfig } from "./types.js";
import * as validation from "./validation-core.js";

afterEach(() => vi.restoreAllMocks());

async function validateThroughCli(
  config: OpenClawConfig,
  schema: Record<string, unknown>,
  channelSchema?: Record<string, unknown>,
) {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "validation-fixture",
        configSchema: schema,
        ...(channelSchema
          ? {
              channels: ["validation-channel"],
              channelConfigs: { "validation-channel": { schema: channelSchema } },
            }
          : {}),
        configContracts: { secretInputs: { paths: [{ path: "credential", expected: "string" }] } },
      },
    ],
  });
  const synchronousMetadata = vi
    .spyOn(metadata, "resolveConfigWidePluginMetadataSnapshot")
    .mockReturnValue(snapshot);
  vi.spyOn(metadata, "resolveConfigWidePluginMetadataSnapshotAsync").mockResolvedValue(snapshot);
  const core = vi.spyOn(validation, "validateConfigObjectRaw");
  const directories = vi.spyOn(agentDirs, "findDuplicateAgentDirs");
  const schemaValidation = vi.spyOn(schemas, "validatePluginSchemaValue");
  const output: unknown[] = [];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    output.push(value);
  });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  await withOpenClawTestState({ prefix: "config-validation-work-" }, async (state) => {
    await state.writeConfig(config);
    const before = fs.readFileSync(state.configPath, "utf8");
    const program = new Command();
    program.exitOverride();
    registerConfigCli(program);
    try {
      await program.parseAsync(["config", "validate", "--json"], { from: "user" });
    } catch (error) {
      expect(error).toMatchObject({ name: "ExitError", code: 1 });
    }
    expect(fs.readFileSync(state.configPath, "utf8")).toBe(before);
  });
  return { output: output.at(-1), core, directories, schemaValidation, synchronousMetadata };
}

it.each([1, 480])("validates one config document for a %i-agent fleet", async (count) => {
  const { output, core, directories, schemaValidation, synchronousMetadata } =
    await validateThroughCli(
      {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(Array.from({ length: count }, (_, i) => [`agent-${i}`, {}])),
        },
        plugins: {
          entries: { "validation-fixture": { enabled: true, config: { label: "fixture" } } },
        },
      },
      { type: "object", properties: { label: { type: "string" } }, additionalProperties: false },
    );
  expect(output).toMatchObject({ valid: true });
  expect(core).toHaveBeenCalledTimes(1);
  expect(directories).toHaveBeenCalledTimes(1);
  expect(schemaValidation).toHaveBeenCalledTimes(1);
  expect(synchronousMetadata).not.toHaveBeenCalled();
});

it.each([
  { rootPath: "/synthetic", valid: true, calls: 1 },
  { rootPath: "~/synthetic", valid: false, calls: 2 },
])("preserves channel schema validation for $rootPath", async ({ rootPath, valid, calls }) => {
  const { output, schemaValidation } = await validateThroughCli(
    {
      channels: { "validation-channel": { rootPath } },
    },
    { type: "object" },
    {
      type: "object",
      properties: {
        rootPath: { type: "string", pattern: "^/" },
        label: { type: "string", default: "synthetic" },
      },
    },
  );
  expect(output).toMatchObject({ valid });
  if (!valid) {
    expect(output).toMatchObject({
      issues: [expect.objectContaining({ path: "channels.validation-channel.rootPath" })],
    });
  }
  expect(schemaValidation).toHaveBeenCalledTimes(calls);
});

it.each([
  { enabled: true, authored: false, valid: true },
  { enabled: true, authored: true, valid: false },
  { enabled: false, authored: true, valid: false },
])(
  "preserves strict default ownership for $enabled/$authored",
  async ({ enabled, authored, valid }) => {
    const { output } = await validateThroughCli(
      {
        plugins: {
          entries: { "validation-fixture": { enabled, ...(authored ? { config: {} } : {}) } },
        },
        secrets: {
          providers: { shared: { source: "file", path: "/synthetic/secrets.json", mode: "json" } },
        },
      },
      {
        type: "object",
        properties: {
          credential: {
            type: "object",
            default: { source: "exec", provider: "shared", id: "synthetic" },
          },
        },
      },
    );
    expect(output).toMatchObject({ valid });
    if (!valid) {
      expect(output).toMatchObject({
        issues: [
          expect.objectContaining({
            path: "plugins.entries.validation-fixture.config.credential",
            message: expect.stringContaining('has source "file" but ref requests "exec"'),
          }),
        ],
      });
    }
  },
);

it("retains raw schema rejection when runtime path normalization changes the input", async () => {
  const { output, schemaValidation } = await validateThroughCli(
    {
      plugins: {
        entries: { "validation-fixture": { enabled: true, config: { rootPath: "~/synthetic" } } },
      },
    },
    { type: "object", properties: { rootPath: { type: "string", pattern: "^/" } } },
  );
  expect(output).toMatchObject({
    valid: false,
    issues: [
      expect.objectContaining({ path: "plugins.entries.validation-fixture.config.rootPath" }),
    ],
  });
  expect(schemaValidation).toHaveBeenCalledTimes(2);
});

it("retains runtime warnings while reusing an inactive authored schema result", async () => {
  const { output, schemaValidation } = await validateThroughCli(
    {
      plugins: { entries: { "validation-fixture": { enabled: false, config: {} } } },
    },
    { type: "object", properties: { label: { type: "string", default: "synthetic" } } },
  );
  expect(output).toMatchObject({
    valid: true,
    warnings: [
      expect.objectContaining({
        path: "plugins.entries.validation-fixture",
        message: expect.stringContaining("plugin disabled"),
      }),
    ],
  });
  expect(schemaValidation).toHaveBeenCalledTimes(1);
});
