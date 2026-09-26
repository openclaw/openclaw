import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetGlobalHookRunner } from "./hook-runner-global.js";
import { installPluginFromPath } from "./install.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "./loader.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";
import { resolvePluginTools } from "./tools.js";

const tempDirs = createTempDirTracker();
const pluginId = "approval-effect-probe";
const toolName = "approval_effect_probe";

function resetRuntime() {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  clearPluginRegistryLoadCache();
  clearPluginMetadataLifecycleCaches();
}

afterEach(() => {
  setEmbeddedPluginApprovalBroker(null);
  setEmbeddedMode(false);
  resetRuntime();
  tempDirs.cleanup();
});

function writeProbePackage(root: string, version: "1.0.0" | "2.0.0") {
  const dir = path.join(root, `source-${version}`);
  fs.mkdirSync(dir, { recursive: true });
  const entry = `probe-${version}.cjs`;
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: pluginId, version, openclaw: { extensions: [`./${entry}`] } }),
  );
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      contracts: { trustedToolPolicies: ["approve-probe"], tools: [toolName] },
      configSchema: {
        type: "object",
        additionalProperties: false,
        required: ["output", "trace", "mode"],
        properties: {
          output: { type: "string" },
          trace: { type: "string" },
          mode: { enum: ["unchanged", "rewrite", "veto"] },
        },
      },
    }),
  );
  // The installed plugin owns real hook callbacks and file I/O; no hook runner is mocked.
  fs.writeFileSync(
    path.join(dir, entry),
    `const fs = require("node:fs");
module.exports = { id: "${pluginId}", register(api) {
  const config = api.pluginConfig;
  const trace = (stage, value) => fs.appendFileSync(config.trace, JSON.stringify({stage, value}) + "\\n");
  api.registerTrustedToolPolicy({
    id: "approve-probe", description: "Approve the probe write", matcher: ["${toolName}"],
    evaluate(event) {
      trace("trusted", event.params.value);
      return { requireApproval: { title: "Original write", description: "Approve original value" } };
    }
  });
  api.on("before_tool_call", (event) => {
    if (event.toolName !== "${toolName}") return;
    trace("ordinary", event.params.value);
    if (config.mode === "veto") return { block: true, blockReason: "Probe veto" };
    if (config.mode === "unchanged") return;
    return {
      params: { value: "replacement" },
      ${version === "2.0.0" ? 'requireApproval: { title: "Replacement write", description: "Approve replacement value" }' : ""}
    };
  });
  api.registerTool({
    name: "${toolName}", label: "Approval effect probe", description: "Write a synthetic fixture value",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    async execute(_id, params) {
      trace("effect", params.value);
      fs.writeFileSync(config.output, params.value);
      return { content: [{ type: "text", text: params.value }], details: { written: true } };
    }
  });
} };`,
  );
  return dir;
}

async function installProbe(root: string, version: "1.0.0" | "2.0.0", mode: "install" | "update") {
  const result = await installPluginFromPath({
    path: writeProbePackage(root, version),
    extensionsDir: path.join(root, "state", "extensions"),
    mode,
  });
  expect(result).toMatchObject({ ok: true, pluginId, version });
  if (!result.ok) {
    throw new Error(result.error);
  }
  expect(
    JSON.parse(fs.readFileSync(path.join(result.targetDir, "package.json"), "utf8")).version,
  ).toBe(version);
  return result.targetDir;
}

type ProbeMode = "unchanged" | "rewrite" | "veto";

async function exerciseProbe(params: {
  root: string;
  installed: string;
  label: string;
  mode: ProbeMode;
  secondDecision?: "allow-once" | "deny";
}) {
  resetRuntime();
  const output = path.join(params.root, `${params.label}.txt`);
  const trace = path.join(params.root, `${params.label}.jsonl`);
  const config: OpenClawConfig = {
    plugins: {
      allow: [pluginId],
      load: { paths: [params.installed] },
      entries: { [pluginId]: { enabled: true, config: { output, trace, mode: params.mode } } },
    },
  };
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: params.root,
    cache: false,
    onlyPluginIds: [pluginId],
  });
  expect(registry.plugins.find((plugin) => plugin.id === pluginId)?.status).toBe("loaded");
  expect(registry.trustedToolPolicies).toHaveLength(1);
  const tool = expectDefined(
    resolvePluginTools({
      context: { config, workspaceDir: params.root },
      runtimeRegistry: registry,
    }).find((candidate) => candidate.name === toolName),
    "installed probe tool",
  );
  const wrapped = wrapToolWithBeforeToolCallHook(tool, { config, workspaceDir: params.root });
  const broker = new EmbeddedPluginApprovalBroker();
  setEmbeddedMode(true);
  setEmbeddedPluginApprovalBroker(broker);
  const readTrace = (): Array<{ stage: string; value: string }> =>
    fs.existsSync(trace)
      ? fs
          .readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  let settled = false;
  const pending = wrapped
    .execute(params.label, { value: "original" })
    .then(
      (result) => ({ kind: "returned" as const, result }),
      (error: unknown) => ({ kind: "threw" as const, error }),
    )
    .then((result) => {
      settled = true;
      return result;
    });
  try {
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    const first = expectDefined(broker.listPending()[0], "original approval");
    expect(first.request.title).toBe("Original write");
    expect(readTrace()).toEqual([{ stage: "trusted", value: "original" }]);
    expect(fs.existsSync(output)).toBe(false);
    expect(broker.resolve(first.id, "allow-once")).toBe(true);
    if (params.secondDecision) {
      await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
      const second = expectDefined(broker.listPending()[0], "replacement approval");
      expect(second.id).not.toBe(first.id);
      expect(second.request.title).toBe("Replacement write");
      expect(settled).toBe(false);
      expect(fs.existsSync(output)).toBe(false);
      expect(readTrace()).toEqual([
        { stage: "trusted", value: "original" },
        { stage: "ordinary", value: "original" },
      ]);
      expect(broker.resolve(second.id, params.secondDecision)).toBe(true);
    }
    const outcome = await pending;
    expect(broker.listPending()).toHaveLength(0);
    const shouldWrite = params.mode === "unchanged" || params.secondDecision === "allow-once";
    const value = params.mode === "unchanged" ? "original" : "replacement";
    expect(readTrace()).toEqual([
      { stage: "trusted", value: "original" },
      { stage: "ordinary", value: "original" },
      ...(shouldWrite ? [{ stage: "effect", value }] : []),
    ]);
    if (shouldWrite) {
      expect(outcome).toMatchObject({
        kind: "returned",
        result: { content: [{ type: "text", text: value }] },
      });
      expect(fs.readFileSync(output, "utf8")).toBe(value);
    } else {
      expect(fs.existsSync(output)).toBe(false);
      if (params.mode === "veto") {
        expect(outcome.kind).toBe("returned");
        expect(JSON.stringify(outcome)).toContain("Probe veto");
      } else {
        expect(outcome.kind).toBe("threw");
        if (!params.secondDecision && outcome.kind === "threw") {
          expect(String(outcome.error)).toContain(
            "Tool call parameters changed after trusted approval",
          );
        }
      }
    }
  } finally {
    broker.stop();
    await pending;
    setEmbeddedPluginApprovalBroker(null);
    setEmbeddedMode(false);
  }
}

async function withProbeRoot(run: (root: string) => Promise<void>) {
  const root = tempDirs.make("openclaw-approval-install-");
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
    async () => await run(root),
  );
}

describe("installed plugin trusted approval reaches only approved file effects", () => {
  it.each([
    { label: "unchanged", mode: "unchanged", version: "1.0.0" },
    { label: "ordinary-veto", mode: "veto", version: "1.0.0" },
    { label: "unapproved-rewrite", mode: "rewrite", version: "1.0.0" },
    { label: "approved-rewrite", mode: "rewrite", version: "2.0.0", secondDecision: "allow-once" },
    { label: "denied-rewrite", mode: "rewrite", version: "2.0.0", secondDecision: "deny" },
  ] as const)("fresh install: $label", async (scenario) => {
    await withProbeRoot(async (root) => {
      const installed = await installProbe(root, scenario.version, "install");
      await exerciseProbe({ root, installed, ...scenario });
    });
  });

  it("updates the installed transforming plugin to request separate approval", async () => {
    await withProbeRoot(async (root) => {
      const legacy = await installProbe(root, "1.0.0", "install");
      await exerciseProbe({ root, installed: legacy, label: "before-upgrade", mode: "rewrite" });
      resetRuntime();
      const upgraded = await installProbe(root, "2.0.0", "update");
      expect(upgraded).toBe(legacy);
      await exerciseProbe({
        root,
        installed: upgraded,
        label: "after-upgrade",
        mode: "rewrite",
        secondDecision: "allow-once",
      });
    });
  });
});
