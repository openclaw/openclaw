import { describe, expect, it } from "vitest";
import { buildSubagentSpawnEnvelope, buildSubagentTaskMessage } from "./subagent-system-prompt.js";

function buildEnvelope(overrides: Partial<Parameters<typeof buildSubagentSpawnEnvelope>[0]> = {}) {
  return buildSubagentSpawnEnvelope({
    completionMode: "announce",
    childSessionKey: "agent:main:subagent:child",
    task: "UNIQUE_SUBAGENT_TASK\n  preserve indentation",
    ...overrides,
  });
}

describe("subagent spawn envelope", () => {
  it.each([
    ["announce", /returns to the requester as a completion event/],
    ["collector", /Collector run: no completion notification/],
    ["quiet", /Quiet run: no completion notification/],
  ] as const)("gives child and requester the same %s contract", (completionMode, expected) => {
    const { systemPrompt, message, acceptedNote } = buildEnvelope({ completionMode });
    expect(systemPrompt).toMatch(expected);
    expect(acceptedNote).toMatch(expected);
    for (const guidance of [systemPrompt, acceptedNote ?? ""]) {
      expect(guidance.includes("collector wait capability")).toBe(completionMode === "collector");
      expect(guidance).not.toMatch(
        /auto-announce|auto-reported|sessions_yield|agents_wait|`message`/,
      );
    }
    expect(systemPrompt.length).toBeLessThan(4_000);
    expect(message).toContain("[Subagent Task]\n\nUNIQUE_SUBAGENT_TASK\n  preserve indentation");
    expect(systemPrompt).not.toContain("UNIQUE_SUBAGENT_TASK");
    expect(`${systemPrompt}\n${message}`.match(/UNIQUE_SUBAGENT_TASK/g)).toHaveLength(1);
    expect(systemPrompt).toMatch(/\[Subagent Task\].*current child session/);
    expect(systemPrompt).toMatch(/inherited task envelopes.*background reference/);
    const soleChild = buildEnvelope({ completionMode, soleCollectorChild: true });
    expect(soleChild.systemPrompt).toBe(systemPrompt);
    expect(soleChild.message).toBe(message);
    if (completionMode === "collector") {
      expect(soleChild.acceptedNote).toBe(
        `${acceptedNote} This is the only collector child in its group so far; unless more parallel children follow, an ordinary spawn (omit collect) is simpler and can be steered.`,
      );
    } else {
      expect(soleChild.acceptedNote).toBe(acceptedNote);
    }
  });

  it.each([
    { childDepth: undefined, maxSpawnDepth: undefined, parent: "main agent", spawning: true },
    { childDepth: 1, maxSpawnDepth: 2, parent: "main agent", spawning: true },
    { childDepth: 2, maxSpawnDepth: 2, parent: "parent orchestrator", spawning: false },
  ])(
    "preserves depth $childDepth/$maxSpawnDepth ownership",
    ({ childDepth, maxSpawnDepth, parent, spawning }) => {
      const { systemPrompt } = buildEnvelope({ childDepth, maxSpawnDepth });
      expect(systemPrompt).toContain(`spawned by ${parent}`);
      expect(systemPrompt.includes("May delegate descendants")).toBe(spawning);
      if (childDepth === 2) {
        expect(systemPrompt).toContain("Leaf worker: cannot spawn");
      }
      expect(systemPrompt).toContain("Truncation notice");
      expect(systemPrompt).toContain("offset/limit");
      expect(systemPrompt).toContain("no full cat");
    },
  );

  it("describes private completion consistently for child and parent", () => {
    const envelope = buildEnvelope({ completionTarget: "parent" });
    for (const text of [envelope.systemPrompt, envelope.acceptedNote]) {
      expect(text).toContain("No result is automatically sent to a channel");
      expect(text).toContain("remain silent");
    }
    expect(envelope.acceptedNote).toContain("private requester turn");
    expect(envelope.acceptedNote).not.toContain("after your final answer");
  });

  it("describes the bounded default recursive depth", () => {
    const envelope = buildEnvelope();

    expect(envelope.message).toContain("depth 1/5");
    expect(envelope.systemPrompt).toContain("May delegate descendants");
  });

  it.each([false, true])(
    "gates ACP guidance without overriding collector restrictions: acp=%s",
    (acpEnabled) => {
      const options = {
        childDepth: 1,
        maxSpawnDepth: 2,
        acpEnabled,
        nativeCommandGuidanceLines: ["Plugin-owned native command guidance."],
      };
      const normal = buildEnvelope(options).systemPrompt;
      expect(normal.includes("ACP harness:")).toBe(acpEnabled);
      expect(normal).toContain("Plugin-owned native command guidance.");
      expect(normal).toContain("Follow each descendant's accepted completion mode");
      const collector = buildEnvelope({ ...options, completionMode: "collector" }).systemPrompt;
      expect(collector).toContain("Descendants must also be collectors");
      expect(collector).toContain("Explicitly collect all required results");
      expect(collector).not.toMatch(/ACP|Plugin-owned|turn-yield|auto-announce|push-based/);
    },
  );

  it("never describes a worker as a persistent conversation owner", () => {
    const envelope = buildEnvelope();
    expect(envelope.systemPrompt).toContain("Ephemeral");
    expect([envelope.message, envelope.systemPrompt, envelope.acceptedNote].join(" ")).not.toMatch(
      /persistent.*thread|delivered directly to the bound thread/,
    );
  });

  it.each([
    ["agent:main:cron:job:run:attempt", true],
    ["agent:main:telegram:chat", false],
    ["agent:main:slack:cron:job:run:attempt", false],
    [undefined, false],
  ])("limits cron receipt suppression to announcing runs: %s", (requesterSessionKey, omitted) => {
    const envelope = buildEnvelope({ requesterSessionKey });
    expect(envelope.acceptedNote === undefined).toBe(omitted);
    for (const completionMode of ["collector", "quiet"] as const) {
      expect(buildEnvelope({ requesterSessionKey, completionMode }).acceptedNote).toBeDefined();
    }
  });
});

it("preserves persistent follow-up guidance for visible app sessions without channel binding", () => {
  const task = { task: "Visible task", childDepth: 1, maxSpawnDepth: 2 };
  const visible = buildSubagentTaskMessage({ ...task, spawnMode: "session" });
  expect(visible).toContain("persistent and remains available for follow-up messages in the app");
  expect(visible).not.toMatch(/bound thread|channel binding/);
  expect(buildSubagentTaskMessage(task)).not.toContain("persistent");
});
