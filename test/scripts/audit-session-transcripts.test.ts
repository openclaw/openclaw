import { describe, expect, it } from "vitest";
import {
  analyzeTranscriptRecords,
  parseTranscriptJsonl,
  type TranscriptAudit,
} from "../../scripts/audit-session-transcripts.ts";

function analyze(raw: string): TranscriptAudit {
  const result = analyzeTranscriptRecords("sample.jsonl", parseTranscriptJsonl(raw));
  if (!result) {
    throw new Error("expected transcript audit result");
  }
  return result;
}

describe("audit-session-transcripts", () => {
  it("detects skill load, skipped preflight, and speculation before evidence", () => {
    const audit = analyze(`
{"type":"session","id":"s1"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"investigate"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"read-1","name":"read","arguments":{"path":"/home/node/.openclaw/skills/morpho-sre/SKILL.md"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"read-1","toolName":"read","content":[{"type":"text","text":"ok"}],"details":{"exitCode":0}}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"exec-1","name":"exec","arguments":{"command":"openclaw status"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"exec-1","toolName":"exec","content":[{"type":"text","text":"sh: 1: openclaw: Permission denied\\n\\n(Command exited with code 127)"}],"details":{"exitCode":127}}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Incident: blocked\\nEvidence: openclaw status failed\\nHypotheses (ranked):\\n1. app crash\\n2. rollout regression\\nNext actions:\\n- run \`kubectl get pods -A\`"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"exec-2","name":"exec","arguments":{"command":"command -v kubectl"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"exec-2","toolName":"exec","content":[{"type":"text","text":"/usr/bin/kubectl"}],"details":{"exitCode":0}}}
`);

    expect(audit.skillReads).toEqual(["morpho-sre"]);
    expect(audit.configuredSkills).toEqual([]);
    expect(audit.preflight.score).toBe(0);
    expect(audit.discussion.speculationBeforeEvidence).toBe(true);
    expect(audit.discussion.blockedReplyHasExactError).toBe(false);
    expect(audit.discussion.blockedReplyHasNextChecks).toBe(true);
    expect(audit.retrieval.score).toBe(0);
    expect(audit.delegation.score).toBe(0);
  });

  it("credits strong preflight before first analysis", () => {
    const audit = analyze(`
{"type":"session","id":"s2"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"investigate"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"exec-1","name":"exec","arguments":{"command":"command -v kubectl; command -v aws"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"exec-1","toolName":"exec","content":[{"type":"text","text":"/usr/bin/kubectl\\n/usr/bin/aws"}],"details":{"exitCode":0}}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"exec-2","name":"exec","arguments":{"command":"aws sts get-caller-identity"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"exec-2","toolName":"exec","content":[{"type":"text","text":"{\\"Account\\":\\"123\\"}"}],"details":{"exitCode":0}}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"exec-3","name":"exec","arguments":{"command":"kubectl config current-context"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"exec-3","toolName":"exec","content":[{"type":"text","text":"dev-morpho"}],"details":{"exitCode":0}}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"exec-4","name":"exec","arguments":{"command":"kubectl get ns | sed -n '1,20p'"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"exec-4","toolName":"exec","content":[{"type":"text","text":"default\\nkube-system"}],"details":{"exitCode":0}}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Incident: confirmed from live checks\\nEvidence: cluster reachable"}]}}
`);

    expect(audit.preflight.score).toBe(4);
    expect(audit.preflight.missing).toEqual([]);
    expect(audit.discussion.speculationBeforeEvidence).toBe(false);
  });

  it("detects blocked reply that includes exact error and next checks", () => {
    const audit = analyze(`
{"type":"session","id":"s3"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"investigate"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"exec-1","name":"exec","arguments":{"command":"kubectl get pods -A"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"exec-1","toolName":"exec","content":[{"type":"text","text":"sh: 1: kubectl: Permission denied\\n\\n(Command exited with code 1)"}],"details":{"exitCode":1}}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Incident: blocked by runtime access\\nEvidence: \`kubectl get pods -A\` -> sh: 1: kubectl: Permission denied\\nStatus: blocked\\nNext checks:\\n- \`echo \\"$PATH\\"\`\\n- \`command -v kubectl\`\\n- \`find / -name kubectl 2>/dev/null | head\`"}]}}
`);

    expect(audit.discussion.blockedReplyHasExactError).toBe(true);
    expect(audit.discussion.blockedReplyHasNextChecks).toBe(true);
    expect(audit.discussion.blockedReplyHasSpeculation).toBe(false);
  });

  it("tracks retrieval, delegation, and transcript bloat", () => {
    const audit = analyzeTranscriptRecords(
      "sample.jsonl",
      parseTranscriptJsonl(`
{"type":"session","id":"s4"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"investigate"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"read-1","name":"read","arguments":{"path":"/home/node/.openclaw/skills/morpho-sre/knowledge-index.md"}},{"type":"toolCall","id":"read-2","name":"read","arguments":{"path":"/home/node/.openclaw/skills/morpho-sre/runbook-map.md"}},{"type":"toolCall","id":"deleg-1","name":"sessions_list","arguments":{}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"read-1","toolName":"read","content":[{"type":"text","text":"ok"}],"details":{"exitCode":0}}}
{"type":"message","message":{"role":"toolResult","toolCallId":"read-2","toolName":"read","content":[{"type":"text","text":"ok"}],"details":{"exitCode":0}}}
{"type":"message","message":{"role":"toolResult","toolCallId":"deleg-1","toolName":"sessions_list","content":[{"type":"text","text":"ok"}],"details":{"exitCode":0}}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"exec-1","name":"exec","arguments":{"command":"kubectl get pods -A"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"exec-1","toolName":"exec","content":[{"type":"text","text":"Error from server (Forbidden): pods/exec forbidden\\n\\n(Command exited with code 1)\\n[Read output capped at 50KB]"}],"details":{"exitCode":1}}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"exec-2","name":"exec","arguments":{"command":"kubectl get pods -A"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"exec-2","toolName":"exec","content":[{"type":"text","text":"Error from server (Forbidden): pods/exec forbidden\\n\\n(Command exited with code 1)"}],"details":{"exitCode":1}}}
`),
      { fileBytes: 6_000_000, configuredSkills: ["morpho-sre"], model: "gpt-5.4" },
    );

    if (!audit) {
      throw new Error("expected transcript audit result");
    }
    expect(audit.model).toBe("gpt-5.4");
    expect(audit.configuredSkills).toEqual(["morpho-sre"]);
    expect(audit.retrieval.usedKnowledgeIndex).toBe(true);
    expect(audit.retrieval.usedRunbookMap).toBe(true);
    expect(audit.delegation.score).toBe(1);
    expect(audit.bloat.hugeTranscript).toBe(true);
    expect(audit.bloat.cappedReadMarkers).toBe(1);
    expect(audit.bloat.repeatedExecFailures).toBe(1);
  });
});
