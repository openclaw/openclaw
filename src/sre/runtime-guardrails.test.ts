import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSreRuntimeGuardrailContext,
  buildSreRuntimeGuardrailContextFromTranscript,
  shellEscapeSingleArg,
} from "./runtime-guardrails.js";

describe("shellEscapeSingleArg", () => {
  it("round-trips shell edge cases", () => {
    const samples = ["", "'", `mix'"quotes`, "x".repeat(1_024), "line\n\tbreak", "deja vu déjà"];

    for (const sample of samples) {
      const result = spawnSync("/bin/sh", ["-c", `printf '%s' ${shellEscapeSingleArg(sample)}`], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(sample);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("buildSreRuntimeGuardrailContextFromTranscript", () => {
  it("surfaces human corrections, repeated failures, and retrieval gate", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","arguments":{"path":"/home/node/.openclaw/repos/morpho-org/morpho-api/service.ts"}}]}}
{"type":"message","message":{"role":"toolResult","toolName":"exec","content":[{"type":"text","text":"sh: 1: set: Illegal option -o pipefail"}]}}
{"type":"message","message":{"role":"toolResult","toolName":"exec","content":[{"type":"text","text":"sh: 1: set: Illegal option -o pipefail"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Btw this is wrong, the realtime entry is outdated"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "investigate",
      transcriptText,
    });

    expect(context).toContain("Latest human correction overrides older bot theories");
    expect(context).toContain("Repeated shell/runtime failures detected");
    expect(context).toContain("Retrieval gate");
    expect(context).toContain("switch to blocked mode");
  });

  it("forces a fresh Vercel probe after an access grant correction", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I do not have Vercel access from this environment."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"You now have access to Vercel."}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "check why the docs deploy is not live",
      transcriptText,
    });

    expect(context).toContain("Vercel access is now available");
    expect(context).toContain("case ${VERCEL_TOKEN-} in ''|*[[:space:]]*)");
    expect(context).toContain('echo "VERCEL_TOKEN=set"');
    expect(context).not.toContain("\\${VERCEL_TOKEN:-}");
    expect(context).not.toContain(`printf '%s' "$VERCEL_TOKEN"`);
    expect(context).not.toContain("grep -Eq '^[^[:space:]]+$'");
    expect(context).toContain("bash 'vercel-readonly.sh' 'whoami'");
    expect(context).toContain("'teams' 'list' '--format' 'json'");
  });

  it("uses thread context when the access grant does not restate Vercel", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I do not have Vercel access from this environment."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Access granted."}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "check why the Vercel docs deploy is not live",
      transcriptText,
    });

    expect(context).toContain("Vercel access is now available");
    expect(context).toContain("bash 'vercel-readonly.sh' 'whoami'");
    expect(context).toContain("'teams' 'list' '--format' 'json'");
  });

  it("keeps recent assistant Vercel context after long noisy thread history", () => {
    const noisyAssistantLines = Array.from(
      { length: 30 },
      (_, index) =>
        `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"noise ${index} ${"x".repeat(220)}"}]}}`,
    ).join("\n");
    const transcriptText = `
${noisyAssistantLines}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"This still looks like a Vercel deploy issue."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Access granted."}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "check why the deploy is not live",
      transcriptText,
    });

    expect(context).toContain("Vercel access is now available");
    expect(context).toContain("bash 'vercel-readonly.sh' 'whoami'");
    expect(context).toContain("'teams' 'list' '--format' 'json'");
  });

  it("keeps generic reprobe guidance when Vercel is only mentioned as a negated context", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"This looks unrelated to Vercel so far."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Access granted."}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "check whether GitHub access is fixed",
      transcriptText,
    });

    expect(context).toContain("A human says access/permissions are now available.");
    expect(context).not.toContain("Vercel access is now available");
    expect(context).not.toContain("'teams' 'list' '--format' 'json'");
  });

  it("lets negated Vercel context win when both negated and plain mentions appear", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"This looks like a non-vercel vercel issue so far."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Access granted."}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "check why the deploy is not live",
      transcriptText,
    });

    expect(context).toContain("A human says access/permissions are now available.");
    expect(context).not.toContain("Vercel access is now available");
  });

  it("keeps Vercel reprobe guidance when the grant only appears outside the preview window", () => {
    const previewOverflowPrefix = "heads up ".repeat(Math.ceil(240 / "heads up ".length));
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I do not have Vercel access from this environment."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"${previewOverflowPrefix}You now have access to Vercel."}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "check why the docs deploy is not live",
      transcriptText,
    });

    expect(previewOverflowPrefix.length).toBeGreaterThan(220);
    expect(context).toContain("Vercel access is now available");
    expect(context).toContain("bash 'vercel-readonly.sh' 'whoami'");
    expect(context).toContain("'teams' 'list' '--format' 'json'");
  });

  it("keeps Vercel prompt context when assistant tail exhausts the 4k budget", () => {
    const noisyAssistantLines = Array.from(
      { length: 20 },
      (_, index) =>
        `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"tail ${index} ${"x".repeat(260)}"}]}}`,
    ).join("\n");
    const transcriptText = `
${noisyAssistantLines}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Access granted."}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "check why the Vercel docs deploy is not live",
      transcriptText,
    });

    expect(context).toContain("Vercel access is now available");
    expect(context).toContain("bash 'vercel-readonly.sh' 'whoami'");
    expect(context).toContain("'teams' 'list' '--format' 'json'");
  });

  it("ignores exact artifacts that only appear beyond the retained signal window", () => {
    const beyondSignalWindowPrefix = "artifact padding ".repeat(
      Math.ceil(4_100 / "artifact padding ".length),
    );
    const transcriptText = `
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"${beyondSignalWindowPrefix}query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } }"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "investigate this report",
      transcriptText,
    });

    expect(beyondSignalWindowPrefix.length).toBeGreaterThan(4_000);
    expect(context).toBeUndefined();
  });

  it("keeps Vercel reprobe guidance for mixed and case-insensitive access grants", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I do not have Vercel access from this environment."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"You now have access to VERCEL but not to GitHub."}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "check why the docs deploy is not live",
      transcriptText,
    });

    expect(context).toContain("Vercel access is now available");
    expect(context).toContain("bash 'vercel-readonly.sh' 'whoami'");
    expect(context).toContain("'teams' 'list' '--format' 'json'");
  });

  it("keeps non-Vercel grants on the generic reprobe path", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I do not have access from this environment."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"You now have access to clevercel sandbox."}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "check why the deploy is not live",
      transcriptText,
    });

    expect(context).toContain("A human says access/permissions are now available.");
    expect(context).not.toContain("Vercel access is now available");
    expect(context).not.toContain("'teams' 'list' '--format' 'json'");
  });

  it("renders the Vercel helper path from state-dir or env overrides", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vercel-helper-"));
    const helperPath = path.join(tmpDir, "custom-vercel-skill", "vercel-readonly.sh");
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, "#!/usr/bin/env bash\n");
    await fs.chmod(helperPath, 0o755);
    vi.stubEnv("OPENCLAW_VERCEL_SKILL_DIR", path.dirname(helperPath));
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I do not have Vercel access from this environment."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"You now have access to Vercel."}]}}
`;
    try {
      const context = buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "check why the docs deploy is not live",
        transcriptText,
      });

      expect(context).toContain(helperPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("shell-quotes Vercel helper overrides before rendering guidance commands", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vercel-helper-"));
    const helperPath = path.join(tmpDir, "custom vercel's skill", "vercel-readonly.sh");
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, "#!/usr/bin/env bash\n");
    await fs.chmod(helperPath, 0o755);
    vi.stubEnv("OPENCLAW_VERCEL_SKILL_DIR", path.dirname(helperPath));
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I do not have Vercel access from this environment."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"You now have access to Vercel."}]}}
`;
    try {
      const context = buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "check why the docs deploy is not live",
        transcriptText,
      });

      expect(shellEscapeSingleArg(helperPath)).toContain(`'"'"'`);
      expect(context).toContain(`bash ${shellEscapeSingleArg(helperPath)} 'whoami'`);
      expect(context).toContain("'teams' 'list' '--format' 'json'");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps shell-escaped Vercel helper paths safe for repeated quote sentinels", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vercel-helper-"));
    const helperPath = path.join(tmpDir, `custom'"'"'skill`, "vercel-readonly.sh");
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, "#!/usr/bin/env bash\n");
    await fs.chmod(helperPath, 0o755);
    vi.stubEnv("OPENCLAW_VERCEL_SKILL_DIR", path.dirname(helperPath));
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I do not have Vercel access from this environment."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"You now have access to Vercel."}]}}
`;
    try {
      const context = buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "check why the docs deploy is not live",
        transcriptText,
      });

      expect(helperPath).toContain(`'"'"'`);
      expect(context).toContain(`bash ${shellEscapeSingleArg(helperPath)} 'whoami'`);
      expect(context).toContain("'teams' 'list' '--format' 'json'");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to the seeded Vercel helper for invalid overrides", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vercel-state-"));
    const helperPath = path.join(tmpDir, "skills", "vercel", "vercel-readonly.sh");
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, "#!/usr/bin/env bash\n");
    await fs.chmod(helperPath, 0o755);
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I do not have Vercel access from this environment."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"You now have access to Vercel."}]}}
`;
    try {
      vi.stubEnv("OPENCLAW_VERCEL_SKILL_DIR", "relative/helper");
      const relativeOverrideContext = buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "check why the docs deploy is not live",
        transcriptText,
      });
      expect(relativeOverrideContext).toContain(helperPath);

      vi.stubEnv("OPENCLAW_VERCEL_SKILL_DIR", path.join(tmpDir, "missing-vercel-skill"));
      const missingOverrideContext = buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "check why the docs deploy is not live",
        transcriptText,
      });
      expect(missingOverrideContext).toContain(helperPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("suppresses guidance for non-sre agents", () => {
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "main",
      prompt: "investigate",
      transcriptText: "{}",
    });
    expect(context).toBeUndefined();
  });

  it("ignores malformed transcript lines without throwing", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I do not have Vercel access from this environment."}]}}
{invalid json line}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"You now have access to Vercel."}]}}
`;

    expect(() =>
      buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "check why the docs deploy is not live",
        transcriptText,
      }),
    ).not.toThrow();
  });

  it("does not add retrieval guidance when retrieval docs were already read", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","arguments":{"path":"/home/node/.openclaw/skills/morpho-sre/knowledge-index.md"}},{"type":"toolCall","name":"read","arguments":{"path":"/home/node/.openclaw/repos/morpho-org/morpho-api/service.ts"}}]}}
{"type":"message","message":{"role":"toolResult","toolName":"exec","content":[{"type":"text","text":"Error from server (Forbidden): pods/exec forbidden"}]}}
{"type":"message","message":{"role":"toolResult","toolName":"exec","content":[{"type":"text","text":"Error from server (Forbidden): pods/exec forbidden"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "investigate",
      transcriptText,
    });
    expect(context).toContain("Repeated RBAC exec failures detected");
    expect(context).not.toContain("Retrieval gate");
  });

  it("forces exact-artifact replay and resolver reset for data incidents", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"This is wrong. query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } sentryEventId=abc123"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "look into this vault v2 graphql apy issue",
      transcriptText,
    });

    expect(context).toContain("Latest user-supplied exact artifact detected");
    expect(context).toContain("single-vault API/data incidents");
    expect(context).toContain("single-vault-graphql-evidence.sh");
    expect(context).toContain("DB row/provenance fact");
    expect(context).toContain("db-data-incident-playbook.md");
    expect(context).toContain("Resolver mismatch detected");
  });

  it("allows overriding the single-vault helper path via env", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "single-vault-helper-"));
    const helperPath = path.join(tmpDir, "single-vault-graphql-evidence.sh");
    await fs.writeFile(helperPath, "#!/usr/bin/env bash\n");
    await fs.chmod(helperPath, 0o755);
    vi.stubEnv("SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_PATH", helperPath);
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"This is wrong. query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } sentryEventId=abc123"}]}}
`;
    try {
      const context = buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "look into this vault v2 graphql apy issue",
        transcriptText,
      });

      expect(context).toContain(helperPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("renders helper overrides with display-safe code fences", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "single-vault-helper-"));
    const helperPath = path.join(tmpDir, "single-vault-`evidence`.sh");
    await fs.writeFile(helperPath, "#!/usr/bin/env bash\n");
    await fs.chmod(helperPath, 0o755);
    vi.stubEnv("SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_PATH", helperPath);
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } sentryEventId=abc123"}]}}
`;
    try {
      const context = buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "look into this vault v2 graphql apy issue",
        transcriptText,
      });

      const helperLine = context
        ?.split("\n")
        .find((line) => line.includes("when possible so the exact query replay"));
      expect(helperLine).toContain(helperPath);
      expect(helperLine).toMatch(/^- Use ``.*`` when possible so the exact query replay/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to the seeded runtime helper path for blank or relative env overrides", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "single-vault-state-"));
    const helperPath = path.join(
      tmpDir,
      "skills",
      "morpho-sre",
      "scripts",
      "single-vault-graphql-evidence.sh",
    );
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, "#!/usr/bin/env bash\n");
    await fs.chmod(helperPath, 0o755);
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } sentryEventId=abc123"}]}}
`;
    try {
      vi.stubEnv("SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_PATH", "   ");

      const blankOverrideContext = buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "look into this vault v2 graphql apy issue",
        transcriptText,
      });

      expect(blankOverrideContext).toContain(helperPath);

      vi.stubEnv("SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_PATH", "relative/helper.sh");

      const relativeOverrideContext = buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "look into this vault v2 graphql apy issue",
        transcriptText,
      });

      expect(relativeOverrideContext).toContain(helperPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to the helper basename for missing absolute env overrides", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "single-vault-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    vi.stubEnv(
      "SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_PATH",
      path.join(os.tmpdir(), "missing-single-vault-graphql-evidence.sh"),
    );

    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } sentryEventId=abc123"}]}}
`;
    try {
      const context = buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "look into this vault v2 graphql apy issue",
        transcriptText,
      });

      expect(context).toContain("single-vault-graphql-evidence.sh");
      expect(context).not.toContain("/home/node/.openclaw/skills/morpho-sre/scripts/");
      expect(context).not.toContain(tmpDir);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("normalizes absolute helper overrides before rendering them", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "single-vault-helper-"));
    const nestedDir = path.join(tmpDir, "nested");
    const helperPath = path.join(tmpDir, "single-vault-graphql-evidence.sh");
    await fs.mkdir(nestedDir);
    await fs.writeFile(helperPath, "#!/usr/bin/env bash\n");
    await fs.chmod(helperPath, 0o755);
    vi.stubEnv(
      "SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_PATH",
      `${nestedDir}/../single-vault-graphql-evidence.sh`,
    );

    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } traceId=abc123"}]}}
`;
    try {
      const context = buildSreRuntimeGuardrailContextFromTranscript({
        agentId: "sre",
        prompt: "look into this vault v2 graphql apy issue",
        transcriptText,
      });

      expect(context).toContain(helperPath);
      expect(context).not.toContain(`${nestedDir}/../single-vault-graphql-evidence.sh`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("requires explicit retraction when new evidence contradicts an older theory", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"This is wrong. query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } traceId=abc123"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "look into this vault v2 graphql apy issue",
      transcriptText,
    });

    expect(context).toContain("Explicitly retract the outdated theory");
  });

  it("requires retraction for resolver contradictions even without a human correction", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } traceId=abc123"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "look into this vault v2 graphql apy issue",
      transcriptText,
    });

    expect(context).toContain("Explicitly retract the outdated theory");
    expect(context).toContain("Resolver mismatch detected");
    expect(context).not.toContain("Latest human correction overrides older bot theories");
  });

  it("requires retraction when a correction immediately precedes the latest exact artifact", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Previous theory: pricing cache drift"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"This is wrong. We confirmed the old lead is stale."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } traceId=abc123"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "investigate the exact query",
      transcriptText,
    });

    expect(context).toContain("Explicitly retract the outdated theory");
  });

  it("treats the current prompt as the newest exact artifact", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultByAddress { vaultByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 1) { sharePrice } }"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt:
        'This is wrong. graphql apy is null for one vault. query VaultV2ByAddress { vaultV2ByAddress(address: "0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34", chainId: 999) { apy netApy } } traceId=abc123',
      transcriptText,
    });

    expect(context).toContain("Latest human correction overrides older bot theories");
    expect(context).toContain("Latest user-supplied exact artifact detected");
    expect(context).toContain("single-vault-graphql-evidence.sh");
    expect(context).toContain("DB row/provenance fact");
    expect(context).toContain("`vaultByAddress`");
    expect(context).toContain("`vaultV2ByAddress`");
  });

  it("emits single-vault guardrails on prompt-only first turns", () => {
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt:
        'This is wrong. graphql apy is null for one vault. query VaultV2ByAddress { vaultV2ByAddress(address: "0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34", chainId: 999) { apy netApy } } traceId=abc123',
      transcriptText: "",
    });

    expect(context).toContain("Latest human correction overrides older bot theories");
    expect(context).toContain("Latest user-supplied exact artifact detected");
    expect(context).toContain("single-vault-graphql-evidence.sh");
    expect(context).toContain("DB row/provenance fact");
  });

  it("does not treat wrong-values incident wording as a human correction", () => {
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt:
        'graphql wrong values for one vault. query VaultV2ByAddress { vaultV2ByAddress(address: "0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34", chainId: 999) { apy netApy } } traceId=abc123',
      transcriptText: "",
    });

    expect(context).toContain("Latest user-supplied exact artifact detected");
    expect(context).toContain("single-vault-graphql-evidence.sh");
    expect(context).not.toContain("Latest human correction overrides older bot theories");
    expect(context).not.toContain("Explicitly retract the outdated theory");
  });

  it("does not require retraction without an exact artifact", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: prior theory"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"This is wrong, the previous guess was stale"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "re-check the incident",
      transcriptText,
    });

    expect(context).toContain("Latest human correction overrides older bot theories");
    expect(context).not.toContain("Explicitly retract the outdated theory");
  });

  it("does not require retraction for stale corrections that are separated from the latest artifact", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Previous theory: pricing cache drift"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"This is wrong, the previous guess was stale"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Send the exact query and trace so I can replay it."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } traceId=abc123"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "investigate the exact query",
      transcriptText,
    });

    expect(context).toContain("Latest human correction overrides older bot theories");
    expect(context).not.toContain("Explicitly retract the outdated theory");
  });

  it("detects reverse resolver mismatch", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultV2ByAddress realtime state is missing"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"This is wrong. query VaultByAddress { vaultByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 1) { factory { chain { id } } } }"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "investigate the exact query",
      transcriptText,
    });

    expect(context).toContain("Resolver mismatch detected");
    expect(context).toContain("`vaultV2ByAddress`");
    expect(context).toContain("`vaultByAddress`");
  });

  it("ignores resolver names that only appear in tool output", () => {
    const transcriptText = `
{"type":"message","message":{"role":"toolResult","toolName":"read","content":[{"type":"text","text":"comparison doc: use vaultByAddress for legacy entities"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } traceId=abc123"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "investigate the exact query",
      transcriptText,
    });

    expect(context).not.toContain("Resolver mismatch detected");
    expect(context).not.toContain("Explicitly retract the outdated theory");
  });

  it("suppresses data-incident retrieval guidance when the playbook was already read", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","arguments":{"path":"/home/node/.openclaw/skills/morpho-sre/references/db-data-incident-playbook.md"}}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy } }"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "investigate apy issue",
      transcriptText,
    });

    expect(context).not.toContain("db-data-incident-playbook.md");
    expect(context).toContain("Latest user-supplied exact artifact detected");
  });

  it("does not emit a retrieval gate when repo and retrieval reads share one message", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","arguments":{"path":"/home/node/.openclaw/repos/morpho-org/morpho-api/service.ts"}},{"type":"toolCall","name":"read","arguments":{"path":"/home/node/.openclaw/skills/morpho-sre/knowledge-index.md"}}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "investigate",
      transcriptText,
    });

    expect(context).toBeUndefined();
  });

  it("allows prompt-only data incident signals without null false positives", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Previous triage exists"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "graphql vault v2 apy is null for one vault",
      transcriptText,
    });
    const noFalsePositive = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "pod returns null on readiness check",
      transcriptText,
    });

    expect(context).toContain("db-data-incident-playbook.md");
    expect(context).not.toContain("single-vault-graphql-evidence.sh");
    expect(context).not.toContain("DB row/provenance fact");
    expect(noFalsePositive?.includes("db-data-incident-playbook.md")).not.toBe(true);
  });

  it("treats custom graphql query names as exact artifacts", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Previous triage exists"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Please replay query MyCustomQuery { marketData(chainId: 1) { id } }"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "investigate the exact graphql query",
      transcriptText,
    });

    expect(context).toContain("Latest user-supplied exact artifact detected");
  });

  it("applies prompt-based guardrails to sre-prefixed agents", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Previous triage exists"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre-heartbeat",
      prompt: "graphql vault v2 apy is null for one vault",
      transcriptText,
    });

    expect(context).toContain("db-data-incident-playbook.md");
  });

  it("suppresses missing transcript files", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      buildSreRuntimeGuardrailContext({
        agentId: "sre",
        prompt: "investigate",
        sessionFile: "/tmp/missing.jsonl",
      }),
    ).resolves.toBeUndefined();

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logs unexpected transcript read failures", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      buildSreRuntimeGuardrailContext({
        agentId: "sre",
        prompt: "investigate",
        sessionFile: "/tmp/blocked.jsonl",
      }),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith("sre-guardrail-context-build-failed", {
      sessionFile: "/tmp/blocked.jsonl",
      error: "Error: permission denied",
    });
  });
});
