import { expect, it } from "vitest";
import { createPluginRecord } from "../../plugins/loader-records.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.types.js";
import { createPluginManifestRecordFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createOwnershipHarness } from "../../plugins/registry-ownership.test-support.js";
import { resolveNodeBootstrapPlugins } from "./node-bootstrap-plugins.js";

function createBootstrapRegistry() {
  const registry = createEmptyPluginRegistry();
  const byPluginId = new Map<string, PluginManifestRecord>();
  const addPlugin = (id: string, options: Partial<PluginManifestRecord> = {}) => {
    const metadata = createPluginManifestRecordFixture({
      id,
      rootDir: `/source/extensions/${id}`,
      packageName: `@example/${id}`,
      packageVersion: "1.2.3",
      ...options,
    });
    const record = createPluginRecord({ ...metadata, enabled: true, configSchema: true });
    registry.plugins.push(record);
    byPluginId.set(id, metadata);
    return { metadata, record };
  };
  const addHarness = (id: string, commands: string[]) => {
    const devicePlacement = { requiredNodeCommands: commands, consumesWorkerSlot: false };
    registry.agentHarnesses.push({
      pluginId: id,
      source: `/source/extensions/${id}/index.ts`,
      harness: createOwnershipHarness(id, {
        cloudPlacement: { mode: "remote-exec", devicePlacement },
      }),
    });
  };
  const addCommand = (pluginId: string, command: string) =>
    registry.nodeHostCommands.push({
      pluginId,
      source: `/source/extensions/${pluginId}/index.ts`,
      command: { command, handle: async () => "{}" },
    });
  return { registry, metadata: { byPluginId }, addPlugin, addHarness, addCommand };
}

it("packages the deterministic union of available command owners", () => {
  const fixture = createBootstrapRegistry();
  fixture.addPlugin("harness");
  fixture.addPlugin("native-b", {
    origin: "global",
    trustedOfficialInstall: true,
    rootDir: "/installed/node_modules/@example/native-b",
  });
  fixture.addPlugin("native-a");
  fixture.addPlugin("unrelated");
  fixture.addHarness("harness", ["native.b", "native.a", "native.b"]);
  fixture.addHarness("native-a", ["native.a"]);
  fixture.addCommand("native-a", "native.a");
  fixture.addCommand("native-b", "native.b");
  fixture.addCommand("unrelated", "unrelated.command");
  const { record } = fixture.addPlugin("disabled-harness");
  Object.assign(record, { enabled: false, status: "disabled" });
  fixture.addHarness("disabled-harness", ["missing.command"]);

  expect(resolveNodeBootstrapPlugins({ ...fixture, executionMode: "remote-exec" })).toEqual([
    { id: "native-a", root: "/source/extensions/native-a" },
    { id: "native-b", root: "/installed/node_modules/@example/native-b" },
  ]);
  expect(resolveNodeBootstrapPlugins({ ...fixture, executionMode: "worker-turn" })).toEqual([]);
});

it.each([
  ["missing-command", {}, {}],
  ["disabled-owner", { enabled: false }, {}],
  ["untrusted-owner", {}, { origin: "global" }],
  ["changed-root", {}, { rootDir: "/replacement/native" }],
  ["changed-version", {}, { packageVersion: "1.2.4" }],
] as const)("rejects %s before packaging a runtime", (failure, recordPatch, metadataPatch) => {
  const fixture = createBootstrapRegistry();
  fixture.addPlugin("harness");
  const { metadata, record } = fixture.addPlugin("native");
  fixture.addHarness("harness", ["native.exec"]);
  if (failure !== "missing-command") {
    fixture.addCommand("native", "native.exec");
  }
  Object.assign(record, recordPatch);
  Object.assign(metadata, metadataPatch);

  expect(() => resolveNodeBootstrapPlugins({ ...fixture, executionMode: "remote-exec" })).toThrow(
    /Cloud node bootstrap requires/,
  );
});
