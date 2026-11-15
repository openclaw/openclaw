import { expect, it } from "vitest";
import { stripInternalRuntimeContext } from "../../internal-runtime-context.js";
import { buildSubagentSpawnEnvelope } from "./subagent-system-prompt.js";

const task = "UNIQUE_TASK\n  preserve indentation";
function buildEnvelope(overrides: Partial<Parameters<typeof buildSubagentSpawnEnvelope>[0]> = {}) {
  return buildSubagentSpawnEnvelope({
    completionMode: "announce",
    spawnMode: overrides.completionMode === "thread-direct" ? "session" : "run",
    childSessionKey: "agent:main:subagent:child",
    task,
    ...overrides,
  });
}

it("gives child and requester the same collector contract", () => {
  const { systemPrompt, message, acceptedNote } = buildEnvelope({ completionMode: "collector" });
  for (const guidance of [message, acceptedNote ?? ""]) {
    expect(guidance).toMatch(/Collector run: no completion notification/);
    expect(guidance).toContain("collector wait capability");
    expect(guidance).not.toMatch(
      /auto-announce|auto-reported|sessions_yield|agents_wait|`message`|NO_REPLY/,
    );
  }
  expect(systemPrompt).toContain("Always return a meaningful result or a concrete blocker");
  expect(systemPrompt.length).toBeLessThan(4_000);
  expect(stripInternalRuntimeContext(message)).toBe(task);
  expect(`${systemPrompt}\n${message}`.match(/UNIQUE_TASK/g)).toHaveLength(1);
  expect(systemPrompt).toMatch(/\[Subagent Task\].*current child session/);
  expect(systemPrompt).toMatch(/inherited task envelopes.*background reference/);
  expect(buildEnvelope({ completionMode: "collector", soleCollectorChild: true })).toEqual({
    systemPrompt,
    message,
    acceptedNote: `${acceptedNote} This is the only collector child in its group so far; unless more parallel children follow, an ordinary spawn (omit collect) is simpler and can be steered.`,
  });
});

it("preserves leaf worker ownership at depth 2/2", () => {
  const { systemPrompt } = buildEnvelope({ childDepth: 2, maxSpawnDepth: 2 });
  expect(systemPrompt).toContain("spawned by parent orchestrator");
  expect(systemPrompt).not.toContain("May delegate descendants");
  expect(systemPrompt).toContain("Leaf worker: cannot spawn");
  expect(systemPrompt).toContain("Truncation notice");
  expect(systemPrompt).toContain("offset/limit");
  expect(systemPrompt).toContain("no full cat");
});

it("describes private completion consistently for child and parent", () => {
  const envelope = buildEnvelope({ completionTarget: "parent" });
  for (const text of [envelope.message, envelope.acceptedNote]) {
    expect(text).toContain("No result is automatically sent to a channel");
    expect(text).toContain("continues any unfinished work");
  }
  expect(envelope.acceptedNote).toContain("private requester turn");
  expect(envelope.acceptedNote).not.toContain("after your final answer");
});

it("gates ACP guidance without overriding collector restrictions", () => {
  const options = {
    childDepth: 1,
    maxSpawnDepth: 2,
    acpEnabled: true,
    nativeCommandGuidanceLines: ["Plugin-owned native command guidance."],
  };
  const normal = buildEnvelope(options).message;
  expect(normal).toContain("ACP harness:");
  expect(normal).toContain("Plugin-owned native command guidance.");
  expect(normal).toContain("Follow each descendant's accepted completion mode");
  const collector = buildEnvelope({ ...options, completionMode: "collector" }).message;
  expect(collector).toContain("Descendants must also be collectors");
  expect(collector).toContain("Explicitly collect all required results");
  expect(collector).not.toMatch(/ACP|Plugin-owned|turn-yield|auto-announce|push-based/);
});

it("limits cron receipt suppression to announcing runs", () => {
  const requesterSessionKey = "agent:main:cron:job:run:attempt";
  const envelope = buildEnvelope({ requesterSessionKey });
  expect(envelope.acceptedNote).toBeUndefined();
  for (const completionMode of ["collector", "quiet", "thread-direct"] as const) {
    expect(buildEnvelope({ requesterSessionKey, completionMode }).acceptedNote).toBeDefined();
  }
  expect(buildEnvelope({ requesterSessionKey, spawnMode: "session" }).acceptedNote).toContain(
    "completion event",
  );
});

it("keeps per-spawn identity out of the system prompt so prompts stay cacheable", () => {
  const stablePrompt = buildEnvelope().systemPrompt;
  for (const id of ["first", "second"]) {
    const envelope = buildEnvelope({
      childSessionKey: `agent:main:subagent:${id}`,
      requesterSessionKey: `agent:main:dashboard:${id}`,
      requesterOrigin: { channel: "webchat" },
      label: `worker-${id}`,
    });
    for (const fact of [
      `- Your session: agent:main:subagent:${id}.`,
      `- Requester session: agent:main:dashboard:${id}.`,
      "- Requester channel: webchat.",
      `- Label: worker-${id}`,
    ]) {
      expect(envelope.systemPrompt).not.toContain(fact);
      expect(envelope.message).toContain(fact);
    }
    expect(stripInternalRuntimeContext(envelope.message)).toBe(task);
    expect(envelope.systemPrompt).toBe(stablePrompt);
  }
});
