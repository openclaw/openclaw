import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadGuardrailProvider,
  evaluateGuardrail,
  AllowlistProvider,
} from "../../src/guardrails/index.js";
import type {
  GuardrailProvider,
  GuardrailRequest,
  GuardrailDecision,
} from "../../src/guardrails/types.js";

function makeProvider(overrides: Partial<GuardrailProvider> = {}): GuardrailProvider {
  return {
    name: "test-provider",
    evaluate: vi.fn(async () => ({ allow: true, reasons: [{ code: "allowed" }] })),
    ...overrides,
  };
}

const tempProviderDirs: string[] = [];

function createTempProviderModule(filename: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-guardrails-provider-"));
  tempProviderDirs.push(dir);
  const file = path.join(dir, filename);
  writeFileSync(file, contents, "utf8");
  const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function createTempProviderModuleAbsolute(filename: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-guardrails-provider-"));
  tempProviderDirs.push(dir);
  const file = path.join(dir, filename);
  writeFileSync(file, contents, "utf8");
  return file;
}

afterEach(() => {
  while (tempProviderDirs.length > 0) {
    const dir = tempProviderDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("loadGuardrailProvider", () => {
  it("loads builtin:allowlist", async () => {
    const provider = await loadGuardrailProvider({
      use: "builtin:allowlist",
      config: { deniedTools: ["exec"] },
    });
    expect(provider).toBeInstanceOf(AllowlistProvider);
    expect(provider.name).toBe("allowlist");
  });

  it("passes config to AllowlistProvider", async () => {
    const provider = await loadGuardrailProvider({
      use: "builtin:allowlist",
      config: { allowedTools: ["write"] },
    });
    const decision = await provider.evaluate({
      toolName: "exec",
      toolInput: {},
      timestamp: new Date().toISOString(),
    });
    expect(decision.allow).toBe(false);
  });

  it("throws on invalid module path", async () => {
    await expect(loadGuardrailProvider({ use: "./nonexistent-module.js" })).rejects.toThrow(
      "Failed to load",
    );
  });

  it("loads a named Provider export from a local module", async () => {
    const use = createTempProviderModule(
      "named-provider.mjs",
      [
        "export class Provider {",
        "  constructor() { this.name = 'named-provider'; }",
        "  async evaluate() { return { allow: true, reasons: [{ code: 'allowed' }] }; }",
        "}",
        "",
      ].join("\n"),
    );

    const provider = await loadGuardrailProvider({ use });
    expect(provider.name).toBe("named-provider");
  });

  it("loads a CommonJS object export with a named GuardrailProvider constructor", async () => {
    const use = createTempProviderModule(
      "cjs-provider.cjs",
      [
        "class GuardrailProvider {",
        "  constructor() { this.name = 'cjs-provider'; }",
        "  async evaluate() { return { allow: true, reasons: [{ code: 'allowed' }] }; }",
        "}",
        "module.exports = { GuardrailProvider };",
        "",
      ].join("\n"),
    );

    const provider = await loadGuardrailProvider({ use });
    expect(provider.name).toBe("cjs-provider");
  });

  it("loads a local provider from an absolute path", async () => {
    const use = createTempProviderModuleAbsolute(
      "absolute-provider.mjs",
      [
        "export default class Provider {",
        "  constructor() { this.name = 'absolute-provider'; }",
        "  async evaluate() { return { allow: true, reasons: [{ code: 'allowed' }] }; }",
        "}",
        "",
      ].join("\n"),
    );

    const provider = await loadGuardrailProvider({ use });
    expect(provider.name).toBe("absolute-provider");
  });

  it("loads a transpiled CommonJS default export provider", async () => {
    const use = createTempProviderModule(
      "transpiled-default-provider.cjs",
      [
        "class Provider {",
        "  constructor() { this.name = 'transpiled-default-provider'; }",
        "  async evaluate() { return { allow: true, reasons: [{ code: 'allowed' }] }; }",
        "}",
        "exports.default = Provider;",
        "",
      ].join("\n"),
    );

    const provider = await loadGuardrailProvider({ use });
    expect(provider.name).toBe("transpiled-default-provider");
  });
});

describe("evaluateGuardrail", () => {
  it("returns block=false when provider allows", async () => {
    const provider = makeProvider();
    const result = await evaluateGuardrail(
      provider,
      { toolName: "exec", params: { command: "ls" } },
      true,
    );
    expect(result.block).toBe(false);
  });

  it("returns block=true when provider denies", async () => {
    const provider = makeProvider({
      evaluate: vi.fn(async () => ({
        allow: false,
        reasons: [{ code: "denied", message: "exec blocked" }],
      })),
    });
    const result = await evaluateGuardrail(provider, { toolName: "exec", params: {} }, true);
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("exec blocked");
  });

  it("includes provider name in block reason", async () => {
    const provider = makeProvider({
      name: "my-guardrail",
      evaluate: vi.fn(async () => ({
        allow: false,
        reasons: [{ code: "denied", message: "nope" }],
      })),
    });
    const result = await evaluateGuardrail(provider, { toolName: "exec", params: {} }, true);
    expect(result.blockReason).toContain("my-guardrail");
  });

  it("fail-closed: blocks on provider error", async () => {
    const provider = makeProvider({
      evaluate: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });
    const result = await evaluateGuardrail(provider, { toolName: "exec", params: {} }, true);
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("fail-closed");
    expect(result.blockReason).toContain("see logs");
    expect(result.blockReason).not.toContain("timeout");
  });

  it("fail-open: allows on provider error", async () => {
    const provider = makeProvider({
      evaluate: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });
    const result = await evaluateGuardrail(provider, { toolName: "exec", params: {} }, false);
    expect(result.block).toBe(false);
  });

  it("handles provider returning no reasons", async () => {
    const provider = makeProvider({
      evaluate: vi.fn(async () => ({ allow: false })),
    });
    const result = await evaluateGuardrail(provider, { toolName: "exec", params: {} }, true);
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("blocked by guardrail policy");
  });

  it("handles provider returning empty reasons array", async () => {
    const provider = makeProvider({
      evaluate: vi.fn(async () => ({ allow: false, reasons: [] })),
    });
    const result = await evaluateGuardrail(provider, { toolName: "exec", params: {} }, true);
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("blocked by guardrail policy");
  });

  it("passes context fields to provider", async () => {
    const evaluate = vi.fn(
      async (_req: GuardrailRequest): Promise<GuardrailDecision> => ({
        allow: true,
        reasons: [{ code: "allowed" }],
      }),
    );
    const provider = makeProvider({ evaluate });
    await evaluateGuardrail(
      provider,
      {
        toolName: "write",
        params: { file: "/tmp/test" },
        agentId: "agent-1",
        runId: "run-1",
      },
      true,
    );
    const request = evaluate.mock.calls[0][0];
    expect(request.toolName).toBe("write");
    expect(request.toolInput).toEqual({ file: "/tmp/test" });
    expect(request.agentId).toBe("agent-1");
    expect(request.timestamp).toBeTruthy();
  });
});
