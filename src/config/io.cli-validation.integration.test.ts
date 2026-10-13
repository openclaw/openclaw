import fs from "node:fs";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerConfigCli } from "../cli/config-cli.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as schemas from "../plugins/schema-validator.js";
import { defaultRuntime } from "../runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as metadata from "./io.plugin-metadata.js";
import type { OpenClawConfig } from "./types.js";

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
  vi.spyOn(metadata, "resolveConfigWidePluginMetadataSnapshot").mockReturnValue(snapshot);
  vi.spyOn(metadata, "resolveConfigWidePluginMetadataSnapshotAsync").mockResolvedValue(snapshot);
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
  return { output: output.at(-1), schemaValidation };
}

it("validates existing state through a private read-only snapshot", async () => {
  const output: unknown[] = [];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    output.push(value);
  });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  await withOpenClawTestState({ prefix: "config-validation-existing-state-" }, async (state) => {
    await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
    const before = fs.readFileSync(state.configPath, "utf8");
    openOpenClawStateDatabase({ env: state.env });
    await closeOpenClawStateDatabaseAsync();
    const program = new Command();
    program.exitOverride();
    registerConfigCli(program);
    try {
      await program.parseAsync(["config", "validate", "--json"], { from: "user" });
    } catch (error) {
      expect(error).toMatchObject({ name: "ExitError", code: 1 });
    }
    expect(output.at(-1)).toMatchObject({ valid: true });
    expect(fs.readFileSync(state.configPath, "utf8")).toBe(before);
  });
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
