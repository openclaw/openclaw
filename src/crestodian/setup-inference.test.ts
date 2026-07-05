import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateSetupInference, detectSetupInference } from "./setup-inference.js";

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: false,
    valid: false,
    path: "/tmp/openclaw.json",
    issues: [],
    config: {},
  })),
}));

vi.mock("../commands/onboard-inference.js", async (importActual) => {
  const actual = await importActual<typeof import("../commands/onboard-inference.js")>();
  return {
    ...actual,
    detectInferenceBackends: vi.fn(async () => [
      {
        kind: "claude-cli",
        modelRef: "claude-cli/claude-opus-4-8",
        label: "Claude Code",
        detail: "logged in",
        credentials: true,
      },
      {
        kind: "codex-cli",
        modelRef: "openai/gpt-5.5",
        label: "Codex",
        detail: "installed, not logged in",
        credentials: false,
      },
    ]),
  };
});

const runtime = { log: () => {}, error: () => {}, exit: () => {} } as never;

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "setup-inference-test-"));
}

describe("detectSetupInference", () => {
  it("marks the first non-logged-out candidate recommended", async () => {
    const detection = await detectSetupInference();
    expect(detection.candidates).toHaveLength(2);
    expect(detection.candidates[0]).toMatchObject({ kind: "claude-cli", recommended: true });
    expect(detection.candidates[1]).toMatchObject({ kind: "codex-cli", recommended: false });
    expect(detection.setupComplete).toBe(false);
    expect(detection.workspace.length).toBeGreaterThan(0);
  });
});

describe("activateSetupInference", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists setup only after the live test succeeds", async () => {
    const applySetup = vi.fn(async (_params: unknown) => ({
      configPath: "/tmp/openclaw.json",
      lines: ["ok"],
    }));
    const runCliAgent = vi.fn(async (_params: unknown) => ({
      meta: { finalAssistantVisibleText: "OK" },
    }));
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        runCliAgent: runCliAgent as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelRef).toBe("claude-cli/claude-opus-4-8");
      expect(result.lines).toEqual(["ok"]);
    }
    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(applySetup).toHaveBeenCalledOnce();
    expect(applySetup.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-cli/claude-opus-4-8",
      surface: "gateway",
    });
  });

  it("does not touch config when the live test fails", async () => {
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: [] }));
    const runCliAgent = vi.fn(async () => {
      throw new Error("401 invalid_api_key");
    });
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        runCliAgent: runCliAgent as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid_api_key");
    }
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("treats an empty model reply as a failure", async () => {
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: [] }));
    const runEmbeddedAgent = vi.fn(async () => ({ payloads: [] }));
    const result = await activateSetupInference({
      kind: "anthropic-api-key",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result).toMatchObject({ ok: false, status: "format" });
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("rejects manual activation without a supported provider", async () => {
    const result = await activateSetupInference({
      kind: "api-key",
      provider: "definitely-not-a-provider",
      apiKey: "sk-test",
      surface: "gateway",
      runtime,
      deps: { createTempDir: makeTempDir },
    });
    expect(result).toMatchObject({ ok: false, status: "unavailable" });
  });

  it("runs the codex plugin ensure step only after a passing test", async () => {
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: ["ok"] }));
    const ensureCodex = vi.fn(async () => ({
      cfg: {},
      required: false,
      installed: false,
    }));
    const runEmbeddedAgent = vi.fn(async (_params: unknown) => ({
      meta: { finalAssistantVisibleText: "OK" },
    }));
    const result = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(true);
    expect(ensureCodex).toHaveBeenCalledOnce();
    // Harness selection: codex tests run embedded with the codex harness.
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      agentHarnessId: "codex",
      provider: "openai",
    });
  });
});
