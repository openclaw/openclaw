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
});
