import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseWorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import { assertNativeInferenceAssignment } from "../worker/native-inference-startup.js";
import { nodeWorkerLaunchSecrets } from "./node-worker-child-secrets.js";
import {
  projectNodeWorkerNativeInference,
  snapshotNodeWorkerNativeInference,
} from "./node-worker-native-inference.js";
import {
  TEST_WORKER_ENDPOINT,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const credential = "synthetic-native-key";
const providerHeader = "synthetic-provider-header";
const modelHeader = "synthetic-model-header";

function model(id: string, headers?: Record<string, string>) {
  return {
    id,
    name: id,
    contextWindow: 8192,
    maxTokens: 1024,
    reasoning: false,
    input: ["text"] as Array<"text">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(headers ? { headers } : {}),
  };
}

function snapshot(overrides: Partial<ModelProviderConfig> = {}, platform?: NodeJS.Platform) {
  const provider: ModelProviderConfig = {
    apiKey: credential,
    api: "openai-completions",
    baseUrl: "https://model.example.test/v1",
    headers: { "x-provider": providerHeader },
    models: [model("model-1"), model("model-2", { "x-model": modelHeader })],
    ...overrides,
  };
  const config: OpenClawConfig = { models: { providers: { "provider-1": provider } } };
  return snapshotNodeWorkerNativeInference(config, {}, platform);
}

function descriptor(modelId = "model-1", workspace = tempDirs.make("node-native-")) {
  const input = testWorkerLaunchInput(workspace, "native-turn");
  input.descriptor.assignment.inference = "runtime-local";
  input.descriptor.assignment.modelRef = { provider: "provider-1", model: modelId };
  return parseWorkerLaunchDescriptor({
    ...input.descriptor,
    connectionEndpoint: TEST_WORKER_ENDPOINT,
  });
}

describe("node worker inference config projection", () => {
  it("uses the canonical custom-provider API default", () => {
    const startup = projectNodeWorkerNativeInference(snapshot({ api: undefined })!, descriptor());
    expect(startup.config.models[0]?.api).toBe("openai-completions");
  });

  it("accepts an empty provider header map", () => {
    expect(snapshot({ headers: {}, models: [model("model-1")] })).toBeDefined();
  });

  it("rejects a selected model that is absent from the node config", () => {
    expect(() => projectNodeWorkerNativeInference(snapshot()!, descriptor("missing"))).toThrow(
      "Configure it under models.providers with a usable credential in the node openclaw.json",
    );
  });

  it("captures credentials and header bytes for child diagnostics", () => {
    const assignment = descriptor();
    expect(new Set(nodeWorkerLaunchSecrets(assignment, snapshot()))).toEqual(
      new Set([assignment.admission.credential, credential, providerHeader, modelHeader]),
    );
  });

  it("ignores providers without usable credentials or worker-compatible models", () => {
    for (const overrides of [
      { apiKey: undefined },
      { models: [{ ...model("audio-model"), input: ["audio" as never] }] },
      { api: "azure-openai-responses" as const },
      { api: "google-vertex" as const, apiKey: "gcp-vertex-credentials" },
    ]) {
      expect(snapshot(overrides)).toBeUndefined();
    }
  });

  it("does not advertise worker-local inference on Windows", () => {
    expect(snapshot({}, "win32")).toBeUndefined();
  });

  it("canonicalizes the exact assigned workspace instead of granting a parent tree", () => {
    const root = tempDirs.make("node-native-workspace-");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const link = path.join(root, "workspace-link");
    fs.symlinkSync(workspace, link, "junction");
    const assignment = descriptor("model-1", link);
    const startup = projectNodeWorkerNativeInference(snapshot()!, assignment);
    expect(startup.config.workspace).toBe(fs.realpathSync(workspace));
    expect(() => assertNativeInferenceAssignment(startup, assignment)).not.toThrow();
  });
});
