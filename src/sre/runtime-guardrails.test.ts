import { describe, expect, it } from "vitest";
import { buildSreRuntimeGuardrailContextFromTranscript } from "./runtime-guardrails.js";

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
});
