import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import * as harness from "../src/agents/decision-inference.test-support.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const traceKey = Symbol.for("openclaw.test.onnx-prepared-decisions");
const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Dispose the actual worker before deleting its artifacts, including failed tests.
    await harness.resetDecisionTestRuntime(traceKey);
    syncBuiltinESMExports();
    cleanup();
  }),
);
const modelId = "gliclass-instruct-edge-v1.0";

function writeNativeFixture(modelDir: string) {
  const directory = path.join(modelDir, modelId);
  fs.mkdirSync(directory, { recursive: true });
  // Synthetic ONNX opset13/IR8: logits = Cast(Gather(input_ids, [1,3], axis=1), FLOAT).
  // The graph reads the two rubric-token IDs; reversing descriptions reverses logits.
  // Generated and checked with ONNX helper/checker; no weights or runtime mocks.
  const graph = Buffer.from(
    "CAgSDW9wZW5jbGF3LXRlc3Q6hgIKNQoJaW5wdXRfaWRzCglwb3NpdGlvbnMSCHNlbGVjdGVkIgZHYXRoZXIqCwoEYXhpcxgBoAECCiMKCHNlbGVjdGVkEgZsb2dpdHMiBENhc3QqCQoCdG8YAaABAhIcZGVjaXNpb24tbGFiZWwtdG9rZW4tZml4dHVyZSohCAIQB0IJcG9zaXRpb25zShABAAAAAAAAAAMAAAAAAAAAWiMKCWlucHV0X2lkcxIWChQIBxIQCgIIAQoKEghzZXF1ZW5jZVooCg5hdHRlbnRpb25fbWFzaxIWChQIBxIQCgIIAQoKEghzZXF1ZW5jZWIYCgZsb2dpdHMSDgoMCAESCAoCCAEKAggCQgQKABAN",
    "base64",
  );
  const tokenizer = Buffer.from(
    JSON.stringify({
      model: {
        type: "WordLevel",
        vocab: { "[UNK]": 0, "<<LABEL>>": 1, "<<SEP>>": 2, low: 3, high: 4, world: 5 },
        unk_token: "[UNK]",
      },
      added_tokens: [
        { id: 1, content: "<<LABEL>>", normalized: false, special: true },
        { id: 2, content: "<<SEP>>", normalized: false, special: true },
      ],
      decoder: null,
      normalizer: null,
      post_processor: null,
      pre_tokenizer: { type: "Whitespace" },
    }),
  );
  const files = [
    ["model.onnx", graph],
    ["tokenizer.json", tokenizer],
  ] as const;
  for (const [name, bytes] of files) {
    fs.writeFileSync(path.join(directory, name), bytes);
  }
  fs.writeFileSync(
    path.join(directory, "model.json"),
    JSON.stringify({
      modelId,
      sourceRevision: "727be8a417f6a7718e591b025e07054c146d8139",
      files: files.map(([name, bytes]) => ({
        name,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })),
    }),
  );
}

it("runs the registered native ONNX worker and joins cancellation before replacement", async () => {
  const root = roots.make("onnx-prepared-integration-");
  const modelDir = path.join(root, "models");
  writeNativeFixture(modelDir);
  const { consumerRoot, trace } = harness.createDecisionConsumer(
    root,
    "decision-consumer",
    traceKey,
  );
  const cfg: OpenClawConfig = {
    diagnostics: { enabled: true },
    agents: {
      defaults: { decisionModel: `onnx/${modelId}`, workspace: path.join(root, "workspace") },
    },
    plugins: {
      load: {
        paths: [fileURLToPath(new URL("../extensions/onnx", import.meta.url)), consumerRoot],
      },
      slots: { memory: "none" },
      entries: {
        onnx: { enabled: true, config: { modelDir, threads: 1, maxLoadedModels: 1 } },
        "decision-consumer": { enabled: true },
      },
    },
  };
  // Observe native processes without supplying a worker or replacing its IPC results.
  const spawned = vi.spyOn(childProcess, "spawn");
  syncBuiltinESMExports();
  const env = harness.decisionEnv(root);
  await withEnvAsync(env, async () => {
    const registry = await harness.activateDecisionRegistry(cfg, {
      env,
      preferBuiltPluginArtifacts: false,
      pluginSdkResolution: "src",
    });
    const runtime = trace.runtime;
    assert(runtime);
    await using prepared = await harness.prepareDecisionRuntime(cfg, "onnx", modelId);
    expect(prepared.snapshot.isCurrent()).toBe(true);
    const usage = harness.trackDecisionUsage();
    const questions = {
      route: { type: "choice" as const, criteria: { first: "high", second: "low" } },
    };
    const batch = { state: { type: "text" as const, text: "world" }, questions };
    const first = await runtime.evaluateV2(batch, harness.decisionOptions());
    expect(first.status, JSON.stringify(first)).toBe("ok");
    assert(first.status === "ok");
    const answer = first.result.answers.route;
    assert(answer?.type === "choice");
    expect(answer.choice).toBe("first");
    expect(answer.probabilities?.first).toBeCloseTo(1 / (1 + Math.exp(-1)), 6);
    expect(first.result.usage).toEqual({ inputTokens: 6 });
    expect(first.result.model).toBe(modelId);
    const reversed = await runtime.evaluate(
      {
        state: "world",
        questions: {
          route: { type: "choice", criteria: { first: "low", second: "high" } },
        },
      },
      harness.decisionOptions(),
    );
    assert(reversed.status === "ok");
    expect(reversed.result.answers.route).toMatchObject({ type: "choice", choice: "second" });
    expect(reversed.result.usage).toEqual({ inputTokens: 6 });
    expect(usage).toHaveLength(2);
    expect(spawned).toHaveBeenCalledOnce();
    const spawnedResult = spawned.mock.results[0];
    assert(spawnedResult?.type === "return");
    const child = spawnedResult.value;
    expect(child.spawnargs.some((arg) => arg.includes("inference.worker"))).toBe(true);
    let closed = false;
    child.once("close", () => {
      closed = true;
    });
    const controller = new AbortController();
    const originalSend = child.send;
    let dispatched = false;
    child.send = new Proxy(originalSend, {
      apply(target, thisArg, args) {
        const sent = Reflect.apply(target, thisArg, args);
        const message: unknown = args[0];
        if (
          message &&
          typeof message === "object" &&
          "kind" in message &&
          message.kind === "classify"
        ) {
          dispatched = true;
          // Abort after real IPC dispatch, without claiming an in-kernel barrier.
          controller.abort(new Error("synthetic native cancellation"));
        }
        return sent;
      },
    });
    try {
      await expect(
        runtime.evaluateV2(batch, harness.decisionOptions({ signal: controller.signal })),
      ).rejects.toThrow("synthetic native cancellation");
      expect(dispatched).toBe(true);
      expect(closed).toBe(true);
      expect(usage).toHaveLength(2);
      expect(registry.decisionProviders[0]?.host.inspect(cfg).activeRequests).toBe(0);
    } finally {
      child.send = originalSend;
    }
    const replacement = await runtime.evaluateV2(batch, harness.decisionOptions());
    expect(replacement).toMatchObject({
      status: "ok",
      result: { answers: { route: { choice: "first" } }, usage: { inputTokens: 6 } },
    });
    expect(spawned).toHaveBeenCalledTimes(2);
    expect(usage).toHaveLength(3);
    expect(registry.decisionProviders[0]?.host.inspect(cfg).activeRequests).toBe(0);
  });
}, 30_000);
