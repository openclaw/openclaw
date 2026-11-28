import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { collectBundledChannelConfigsCore } from "./bundled-channel-config-metadata.js";
import {
  createGeneratedPluginTempRoot,
  installGeneratedPluginTempRootCleanup,
} from "./generated-plugin-test-helpers.js";

// mock-isolation: projecting plugin metadata must work without evaluating channel policy schemas.
vi.mock("../channels/plugins/config-schema.js", () => {
  throw new Error("bundled channel metadata imported channel policy schemas");
});

installGeneratedPluginTempRootCleanup();

it("validates a bundled plugin's JSON schema without loading channel policy schemas", () => {
  const pluginDir = createGeneratedPluginTempRoot("openclaw-channel-metadata-");
  const schema = {
    type: "object",
    properties: { enabled: { type: "boolean", default: true } },
  };
  fs.writeFileSync(
    path.join(pluginDir, "channel-config-api.cjs"),
    `exports.ExampleConfigSchema = ${JSON.stringify(schema)};\n`,
  );

  const config = collectBundledChannelConfigsCore({
    pluginDir,
    manifest: { id: "example", channels: ["example"], configSchema: {} },
  })?.example;

  expect(config?.schema).toEqual(schema);
  expect(config?.runtime?.safeParse({})).toEqual({ success: true, data: { enabled: true } });
  expect(config?.runtime?.safeParse({ enabled: "yes" })).toMatchObject({
    success: false,
    issues: [{ path: ["enabled"] }],
  });
});
