import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSreRuntimeGuardrailContext,
  buildSreRuntimeGuardrailContextFromTranscript,
} from "./runtime-guardrails.js";

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

  it("suppresses guidance for non-sre agents", () => {
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "main",
      prompt: "investigate",
      transcriptText: "{}",
    });
    expect(context).toBeUndefined();
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

  it("falls back to the default helper path for blank or relative env overrides", () => {
    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } sentryEventId=abc123"}]}}
`;
    vi.stubEnv("SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_PATH", "   ");

    const blankOverrideContext = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "look into this vault v2 graphql apy issue",
      transcriptText,
    });

    expect(blankOverrideContext).toContain(
      "/home/node/.openclaw/skills/morpho-sre/scripts/single-vault-graphql-evidence.sh",
    );

    vi.stubEnv("SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_PATH", "relative/helper.sh");

    const relativeOverrideContext = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "look into this vault v2 graphql apy issue",
      transcriptText,
    });

    expect(relativeOverrideContext).toContain(
      "/home/node/.openclaw/skills/morpho-sre/scripts/single-vault-graphql-evidence.sh",
    );
  });

  it("falls back to the default helper path for missing absolute env overrides", () => {
    vi.stubEnv(
      "SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_PATH",
      path.join(os.tmpdir(), "missing-single-vault-graphql-evidence.sh"),
    );

    const transcriptText = `
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } sentryEventId=abc123"}]}}
`;
    const context = buildSreRuntimeGuardrailContextFromTranscript({
      agentId: "sre",
      prompt: "look into this vault v2 graphql apy issue",
      transcriptText,
    });

    expect(context).toContain(
      "/home/node/.openclaw/skills/morpho-sre/scripts/single-vault-graphql-evidence.sh",
    );
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
