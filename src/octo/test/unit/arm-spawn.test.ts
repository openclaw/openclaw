// Octopus Orchestrator -- Unit tests for `openclaw octo arm spawn` CLI
//
// Tests the validation, ArmSpec construction, formatting, and the
// runArmSpawn entry point with mocked OctoGatewayHandlers.
//
// Boundary discipline (OCTO-DEC-033): only `node:*` builtins,
// vitest, and relative imports inside `src/octo/`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildArmSpecFromOptions,
  formatArmSpawn,
  formatArmSpawnJson,
  runArmSpawn,
  validateArmSpawnOptions,
} from "../../cli/arm-spawn.ts";
import { HandlerError } from "../../wire/gateway-handlers.ts";
import type { OctoArmSpawnResponse } from "../../wire/methods.ts";

// ──────────────────────────────────────────────────────────────────────────
// Temp directory for spec file tests
// ──────────────────────────────────────────────────────────────────────────

const TMP_DIR = mkdtempSync(path.join(tmpdir(), "octo-arm-spawn-test-"));
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function capture(): { out: { write: (s: string) => void }; text: () => string } {
  const chunks: string[] = [];
  return {
    out: { write: (s: string) => chunks.push(s) },
    text: () => chunks.join(""),
  };
}

const SAMPLE_RESPONSE: OctoArmSpawnResponse = {
  arm_id: "arm-test-001",
  session_ref: {
    tmux_session_name: "octo-arm-arm-test-001",
    cwd: "/tmp/test",
    attach_command: "tmux attach -t octo-arm-arm-test-001",
  },
};

function mockHandlers(response?: OctoArmSpawnResponse, error?: HandlerError) {
  return {
    armSpawn: async (_req: unknown) => {
      if (error) {
        throw error;
      }
      return response ?? SAMPLE_RESPONSE;
    },
  } as never;
}

// ──────────────────────────────────────────────────────────────────────────
// validateArmSpawnOptions
// ──────────────────────────────────────────────────────────────────────────

describe("validateArmSpawnOptions", () => {
  it("accepts valid spec-file mode", () => {
    const result = validateArmSpawnOptions({ specFile: "/some/path.json" });
    expect(result.ok).toBe(true);
  });

  it("rejects empty spec-file path", () => {
    const result = validateArmSpawnOptions({ specFile: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("--spec-file");
    }
  });

  it("accepts valid individual flags", () => {
    const result = validateArmSpawnOptions({
      mission: "m-1",
      adapter: "pty_tmux",
      runtime: "tmux:bash",
      agentId: "agent-1",
      cwd: "/tmp",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing --mission", () => {
    const result = validateArmSpawnOptions({
      adapter: "pty_tmux",
      runtime: "tmux:bash",
      agentId: "agent-1",
      cwd: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("--mission");
    }
  });

  it("rejects invalid --adapter", () => {
    const result = validateArmSpawnOptions({
      mission: "m-1",
      adapter: "bogus",
      runtime: "tmux:bash",
      agentId: "agent-1",
      cwd: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("bogus");
    }
  });

  it("rejects missing --cwd", () => {
    const result = validateArmSpawnOptions({
      mission: "m-1",
      adapter: "pty_tmux",
      runtime: "tmux:bash",
      agentId: "agent-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("--cwd");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// buildArmSpecFromOptions
// ──────────────────────────────────────────────────────────────────────────

describe("buildArmSpecFromOptions", () => {
  it("builds a pty_tmux spec with defaults", () => {
    const spec = buildArmSpecFromOptions({
      mission: "m-1",
      adapter: "pty_tmux",
      runtime: "tmux:bash",
      agentId: "agent-1",
      cwd: "/tmp/work",
    });

    expect(spec.spec_version).toBe(1);
    expect(spec.mission_id).toBe("m-1");
    expect(spec.adapter_type).toBe("pty_tmux");
    expect(spec.runtime_name).toBe("tmux:bash");
    expect(spec.agent_id).toBe("agent-1");
    expect(spec.cwd).toBe("/tmp/work");
    expect((spec.runtime_options as Record<string, unknown>).command).toBe("bash");
  });

  it("includes optional fields when provided", () => {
    const spec = buildArmSpecFromOptions({
      mission: "m-1",
      adapter: "pty_tmux",
      runtime: "tmux:bash",
      agentId: "agent-1",
      cwd: "/tmp",
      initialInput: "hello world",
      habitat: "node-1",
      capabilities: ["tool.git"],
      labels: ["env=test", "owner=ci"],
    });

    expect(spec.initial_input).toBe("hello world");
    expect(spec.desired_habitat).toBe("node-1");
    expect(spec.desired_capabilities).toEqual(["tool.git"]);
    expect(spec.labels).toEqual({ env: "test", owner: "ci" });
  });

  it("builds a structured_subagent spec with model", () => {
    const spec = buildArmSpecFromOptions({
      mission: "m-1",
      adapter: "structured_subagent",
      runtime: "openclaw-subagent",
      agentId: "agent-1",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
    });

    expect(spec.adapter_type).toBe("structured_subagent");
    expect((spec.runtime_options as Record<string, unknown>).model).toBe("claude-sonnet-4-6");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// formatArmSpawn / formatArmSpawnJson
// ──────────────────────────────────────────────────────────────────────────

describe("formatArmSpawn", () => {
  it("includes arm_id and tmux session", () => {
    const output = formatArmSpawn(SAMPLE_RESPONSE);
    expect(output).toContain("arm-test-001");
    expect(output).toContain("octo-arm-arm-test-001");
    expect(output).toContain("spawned successfully");
  });
});

describe("formatArmSpawnJson", () => {
  it("returns valid JSON", () => {
    const output = formatArmSpawnJson(SAMPLE_RESPONSE);
    const parsed = JSON.parse(output);
    expect(parsed.arm_id).toBe("arm-test-001");
    expect(parsed.session_ref.tmux_session_name).toBe("octo-arm-arm-test-001");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// runArmSpawn
// ──────────────────────────────────────────────────────────────────────────

describe("runArmSpawn", () => {
  it("returns 1 on validation failure", async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runArmSpawn(mockHandlers(), {}, stdout.out, stderr.out);
    expect(code).toBe(1);
    expect(stderr.text()).toContain("--mission");
  });

  it("returns 0 on success with human output", async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runArmSpawn(
      mockHandlers(),
      {
        mission: "m-1",
        adapter: "pty_tmux",
        runtime: "tmux:bash",
        agentId: "agent-1",
        cwd: "/tmp",
      },
      stdout.out,
      stderr.out,
    );
    expect(code).toBe(0);
    expect(stdout.text()).toContain("arm-test-001");
    expect(stderr.text()).toBe("");
  });

  it("returns 0 on success with --json", async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runArmSpawn(
      mockHandlers(),
      {
        mission: "m-1",
        adapter: "pty_tmux",
        runtime: "tmux:bash",
        agentId: "agent-1",
        cwd: "/tmp",
        json: true,
      },
      stdout.out,
      stderr.out,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.text());
    expect(parsed.arm_id).toBe("arm-test-001");
  });

  it("returns 1 on invalid_spec HandlerError", async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runArmSpawn(
      mockHandlers(undefined, new HandlerError("invalid_spec", "bad spec")),
      {
        mission: "m-1",
        adapter: "pty_tmux",
        runtime: "tmux:bash",
        agentId: "agent-1",
        cwd: "/tmp",
      },
      stdout.out,
      stderr.out,
    );
    expect(code).toBe(1);
    expect(stderr.text()).toContain("invalid ArmSpec");
  });

  it("returns 1 on policy_denied HandlerError", async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runArmSpawn(
      mockHandlers(undefined, new HandlerError("policy_denied", "not allowed")),
      {
        mission: "m-1",
        adapter: "pty_tmux",
        runtime: "tmux:bash",
        agentId: "agent-1",
        cwd: "/tmp",
      },
      stdout.out,
      stderr.out,
    );
    expect(code).toBe(1);
    expect(stderr.text()).toContain("policy denied");
  });

  it("reads spec from --spec-file", async () => {
    const specPath = path.join(TMP_DIR, "test-spec.json");
    const specData = {
      spec_version: 1,
      mission_id: "m-file",
      adapter_type: "pty_tmux",
      runtime_name: "tmux:bash",
      agent_id: "agent-1",
      cwd: "/tmp",
      idempotency_key: "file-key-1",
      runtime_options: { command: "bash" },
    };
    writeFileSync(specPath, JSON.stringify(specData));

    const stdout = capture();
    const stderr = capture();
    const code = await runArmSpawn(mockHandlers(), { specFile: specPath }, stdout.out, stderr.out);
    expect(code).toBe(0);
    expect(stdout.text()).toContain("arm-test-001");
  });

  it("returns 1 for missing spec file", async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runArmSpawn(
      mockHandlers(),
      { specFile: "/nonexistent/path.json" },
      stdout.out,
      stderr.out,
    );
    expect(code).toBe(1);
    expect(stderr.text()).toContain("failed to read spec file");
  });
});
