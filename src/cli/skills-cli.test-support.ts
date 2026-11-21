import { vi } from "vitest";
import type { ClawHubSkillVerificationResponse } from "../infra/clawhub-skills.js";
import type { SkillStatusEntry } from "../skills/discovery/status.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";

export function skill(name: string, overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  const entry = {
    name,
    skillKey: name,
    description: "A test skill",
    source: "bundled",
    bundled: false,
    filePath: "/path/to/SKILL.md",
    baseDir: "/path/to",
    emoji: "🧪",
    homepage: "https://example.com",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: true,
    platformIncompatible: false,
    modelVisible: true,
    userInvocable: true,
    commandVisible: true,
    ...createEmptyInstallChecks(),
    ...overrides,
  };
  entry.modelVisible = overrides.modelVisible ?? (entry.eligible && !entry.blockedByAgentFilter);
  entry.commandVisible =
    overrides.commandVisible ??
    (entry.eligible && !entry.blockedByAgentFilter && entry.userInvocable);
  return entry;
}

export function verification(overrides: Partial<ClawHubSkillVerificationResponse> = {}) {
  return {
    schema: "clawhub.skill.verify.v1",
    ok: true,
    decision: "pass",
    reasons: [],
    skill: { slug: "agentreceipt" },
    publisher: { handle: "openclaw" },
    version: { version: "1.0.0" },
    card: { available: true },
    artifact: { sourceFingerprint: "source-fp" },
    provenance: null,
    security: { status: "clean" },
    signature: { status: "unsigned" },
    ...overrides,
  };
}

export function runtimeFixture(exitOnSuccess = false, joinErrors = false) {
  const stdout: string[] = [];
  const errors: string[] = [];
  return {
    stdout,
    errors,
    runtime: {
      log: vi.fn(),
      error: vi.fn((...args: unknown[]) => {
        errors.push(joinErrors ? args.map(String).join(" ") : String(args[0]));
      }),
      writeStdout: vi.fn((value: string) => {
        stdout.push(value.endsWith("\n") ? value.slice(0, -1) : value);
      }),
      writeJson: vi.fn((value: unknown, space = 2) => {
        stdout.push(JSON.stringify(value, null, space > 0 ? space : undefined));
      }),
      exit: vi.fn((code: number) => {
        if (exitOnSuccess || code !== 0) {
          throw new Error(`__exit__:${code}`);
        }
      }),
    },
  };
}
