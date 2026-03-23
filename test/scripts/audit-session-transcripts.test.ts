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
    expect(audit.retrieval.usedDbDataIncidentPlaybook).toBe(false);
    expect(audit.delegation.score).toBe(1);
    expect(audit.bloat.hugeTranscript).toBe(true);
    expect(audit.bloat.cappedReadMarkers).toBe(1);
    expect(audit.bloat.repeatedExecFailures).toBe(1);
  });

  it("flags consumer approval failures that drift scope and contradict no-access claims", () => {
    const audit = analyze(`
{"type":"session","id":"s5"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"user succeeded to interact by toggling off the offchain approval on the app. seems there might be an issue with the offchain approval. investigate with Sentry PostHog and Foundry."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I don't have credentials or API access to Sentry or PostHog from this environment."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"I don't have access to Linear, so I can only recap this thread."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Root cause confirmed: The user has 0 USDT balance."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Checked both — here's what Sentry and PostHog show. Sentry (morpho-consumer): unrelated event. PostHog (vmv1): user not tracked."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Here's the consolidated recap from Linear + this investigation: VMV1-4786, VMV1-4693, VMV1-4299."}]}}
`);

    expect(audit.retrieval.usedFrontendResolver).toBe(false);
    expect(audit.retrieval.usedKnownIssueSearch).toBe(true);
    expect(audit.discussion.consumerTxBugContext).toBe(true);
    expect(audit.discussion.falseAccessClaim).toBe(true);
    expect(audit.discussion.workaroundScopeIgnored).toBe(true);
    expect(audit.discussion.certaintyWithoutKnownIssueSearch).toBe(false);
  });

  it("flags exact-artifact replay misses and resolver mismatch for data incidents", () => {
    const audit = analyze(`
{"type":"session","id":"s6"}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Likely cause: vaultByAddress factory.chain is null"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"This is wrong. query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy netApy } } sentryEventId=3317372fa9bb4a9d8849d3cff00dbd48 traceId=6763bbc6fbca68b84c892ba063e131a9"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Likely cause: chain 999 scheduler is missing"}]}}
`);

    expect(audit.discussion.exactArtifactReplayMissed).toBe(true);
    expect(audit.discussion.exactArtifactReplayBeforeSpeculation).toBe(false);
    expect(audit.discussion.resolverMismatch).toBe(true);
    expect(audit.discussion.dataIncidentWithoutPlaybook).toBe(true);
    expect(audit.retrieval.usedDbDataIncidentPlaybook).toBe(false);
  });

  it("credits replay when a tool call uses the exact user artifact before speculation", () => {
    const audit = analyze(`
{"type":"session","id":"s7"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"query VaultV2ByAddress { vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy } }"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"exec-1","name":"exec","arguments":{"command":"curl https://api.morpho.org/graphql --data '{ vaultV2ByAddress(address: \\"0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34\\", chainId: 999) { apy } }'"}}]}}
{"type":"message","message":{"role":"toolResult","toolCallId":"exec-1","toolName":"exec","content":[{"type":"text","text":"{\\"data\\":{\\"vaultV2ByAddress\\":{\\"apy\\":null}}}"}],"details":{"exitCode":0}}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Likely cause: missing realtime state for this vault"}]}}
`);

    expect(audit.discussion.exactArtifactReplayBeforeSpeculation).toBe(true);
    expect(audit.discussion.exactArtifactReplayMissed).toBe(false);
  });

  it("flags progress-only chatter and missing retraction after a human correction", () => {
    const audit = analyze(`
{"type":"session","id":"s8"}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Likely cause: UI label mismatch in PendingTimelockCard"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Now let me verify the history ordering."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Let me compose the response."}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"This is not a UI problem. The bug is that the last action is increase timelock to 3, not decrease to 1."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"*Incident:* Pending timelock mismatch. *Likely cause:* stale pending action history."}]}}
`);

    expect(audit.discussion.progressOnlyReplyCount).toBe(2);
    expect(audit.discussion.contradictionWithoutRetraction).toBe(true);
  });

  it("does not count substantive replies that happen to contain the word good", () => {
    const audit = analyze(`
{"type":"session","id":"s8b"}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Good evidence from the replay: the pending action matches the latest onchain state."}]}}
`);

    expect(audit.discussion.progressOnlyReplyCount).toBe(0);
  });

  it("does not count substantive replies that use progress words mid-sentence", () => {
    const audit = analyze(`
{"type":"session","id":"s8c"}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"*Incident:* After checking all pod logs, the root cause is OOM in the indexer."}]}}
`);

    expect(audit.discussion.progressOnlyReplyCount).toBe(0);
  });

  it("does not flag contradiction recovery when the assistant retracts the stale theory", () => {
    const audit = analyze(`
{"type":"session","id":"s9"}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Likely cause: UI label mismatch in PendingTimelockCard"}]}}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"This is not a UI problem. The bug is that the last action is increase timelock to 3, not decrease to 1."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"*Incident:* Re-scoped.\\nDisproved theory: earlier UI-label theory was wrong.\\n*Evidence:* latest human correction and replay point to chronology, not rendering."}]}}
`);

    expect(audit.discussion.contradictionWithoutRetraction).toBe(false);
  });
});
