import { describe, expect, it } from "vitest";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../cron/scratch-contract.js";
import {
  parseHeartbeatQuestionDocument,
  removeHeartbeatQuestionGroup,
  serializeHeartbeatQuestionDocument,
  upsertHeartbeatQuestionGroup,
} from "./heartbeat-questions.js";

function document(notes = "") {
  const parsed = parseHeartbeatQuestionDocument(notes);
  if (parsed.status === "invalid") {
    throw new Error(parsed.error);
  }
  return parsed.document;
}
const group = {
  id: "deploy",
  commands: ["deployment-status"],
  questions: [{ id: "blocked", question: "Blocked?" }],
  execution: {
    toolsAllow: ["exec"],
    scheduledToolPolicy: { version: 1 as const, mode: "trusted" as const },
  },
};
describe("heartbeat group documents", () => {
  it.each(["\n Watch deployment status.\n", '{"questions":["legacy"],"version":99}'])(
    "preserves legacy notes and replaces whole groups: %s",
    (notes) => {
      const original = document(notes);
      const added = upsertHeartbeatQuestionGroup(original, group);
      const replacement = {
        ...group,
        commands: ["new-status"],
        questions: [{ id: "ready", question: "Ready?" }],
      };
      const updated = upsertHeartbeatQuestionGroup(added, replacement);
      expect(parseHeartbeatQuestionDocument(serializeHeartbeatQuestionDocument(updated))).toEqual({
        status: "valid",
        document: { ...original, groups: [replacement] },
      });
      expect(original.groups).toEqual([]);
      expect(added.groups).toEqual([group]);
      expect(removeHeartbeatQuestionGroup(updated, "deploy")).toEqual(original);
    },
  );
  it.each([
    { commands: [] },
    { commands: [" "] },
    { commands: Array(6).fill("status") },
    { questions: [] },
    { questions: [{ id: "bad.id", question: "Ready?" }] },
    {
      questions: [
        { id: "a", question: "Ready?" },
        { id: "a", question: "Done?" },
      ],
    },
    { questions: [{ id: "a", question: "x".repeat(2001) }] },
    { execution: undefined },
  ])("rejects incomplete or unbounded group inputs: %j", (patch) => {
    expect(
      parseHeartbeatQuestionDocument(
        JSON.stringify({ ...document(), groups: [{ ...group, ...patch }] }),
      ).status,
    ).toBe("invalid");
  });
  it("fails visibly for unsupported or damaged envelopes", () => {
    for (const content of [
      '{"kind":"openclaw-heartbeat-questions","version":1,"notes":"","questions":[]}',
      '{"kind":"openclaw-heartbeat-questions","groups":[',
    ]) {
      expect(parseHeartbeatQuestionDocument(content).status).toBe("invalid");
    }
  });
  it("allows replacement at the group cap but rejects adding beyond it", () => {
    const full = {
      ...document(),
      groups: Array.from({ length: 16 }, (_, i) => ({ ...group, id: `g${i}` })),
    };
    expect(upsertHeartbeatQuestionGroup(full, { ...group, id: "g0" }).groups).toHaveLength(16);
    expect(() => upsertHeartbeatQuestionGroup(full, group)).toThrow("at most 16");
  });
  it("enforces the existing scratch byte cap on the whole document", () => {
    expect(() =>
      serializeHeartbeatQuestionDocument({
        ...document(),
        notes: "é".repeat(CRON_JOB_SCRATCH_MAX_BYTES / 2),
      }),
    ).toThrow("cron scratch exceeds");
  });
});
