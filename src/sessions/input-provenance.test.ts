import { expect, it } from "vitest";
import {
  annotateInterSessionPromptText,
  applyInputProvenanceToUserMessage,
  INTER_SESSION_PROMPT_PREFIX_BASE,
  normalizeInputProvenance,
  readInterSessionPromptEnvelope,
  shouldPreserveUserFacingSessionStateForInputProvenance as preserves,
  stripInterSessionPromptPrefixForDisplay,
} from "./input-provenance.js";

const interSession = {
  kind: "inter_session",
  sourceSessionKey: "agent:main:discord:source",
  sourceTool: "sessions_send",
  sourceChannel: "webchat",
} as const;
const annotate = (text: string) => annotateInterSessionPromptText(text, interSession);

it("retains cron run identity without changing the model-facing prompt", () => {
  const expected = {
    kind: "internal_system" as const,
    sourceTool: "cron",
    sourcePromptPrefix: "[cron:daily-monitor Daily\nmonitor]",
    jobId: "daily-monitor",
    runId: "run-1",
    sourceSessionKey: "agent:main:cron:daily-monitor:run:run-1",
  };
  const provenance = normalizeInputProvenance({
    ...expected,
    jobId: " daily-monitor ",
    runId: " run-1 ",
  });
  expect(provenance).toEqual(expected);
  const prompt = "[cron:daily-monitor Daily monitor] Read REFRESH.md.\n    Keep indentation.\n";
  expect(annotateInterSessionPromptText(prompt, provenance)).toBe(prompt);
});
it.each(["plain body", "decorated envelope", "foreign marker"])(
  "wraps %s without losing provenance or bytes",
  (kind) => {
    const body = "\n    first line\n      second line\n\n";
    const input =
      kind === "decorated envelope"
        ? `startup context\n\n${annotate(body)}`
        : kind === "foreign marker"
          ? `[Inter-session message]\n${body}`
          : body;
    const text = annotate(input);
    expect(text).toMatch(/^\[Inter-session message\]/);
    expect(text.match(/\[Inter-session message\]/g)).toHaveLength(1);
    expect(text).toContain("sourceSession=agent:main:discord:source");
    expect(text).toContain("sourceTool=sessions_send");
    expect(text).toContain("isUser=false");
    const envelope = readInterSessionPromptEnvelope(text);
    const expected = kind === "decorated envelope" ? `startup context\n${body}` : body;
    expect(envelope?.provenance).toEqual(interSession);
    expect(text.slice(envelope?.length)).toBe(expected);
    expect(stripInterSessionPromptPrefixForDisplay(text)).toBe(expected);
  },
);
it("preserves body bytes when the generated explanation is absent", () => {
  expect(
    stripInterSessionPromptPrefixForDisplay(`${INTER_SESSION_PROMPT_PREFIX_BASE}    code`),
  ).toBe("    code");
});
it("ignores headers without the generated explanation or with unknown fields", () => {
  expect(
    readInterSessionPromptEnvelope(`${INTER_SESSION_PROMPT_PREFIX_BASE} isUser=false\nhello`),
  ).toBeUndefined();
  const generated = annotateInterSessionPromptText("x", { kind: "inter_session" });
  const unknownField = generated.replace("isUser=false", "sourceRole=user isUser=false");
  expect(readInterSessionPromptEnvelope(unknownField)).toBeUndefined();
  expect(readInterSessionPromptEnvelope(`quoted ${generated}`)).toBeUndefined();
});
it("marks only explicit scheduled execution inputs as hidden at creation", () => {
  const execution = { kind: "internal_system", sourceTool: "cron_execution" } as const;
  const message = {
    role: "user",
    content: "[cron:daily Daily check] Check the queue.",
    timestamp: 1,
  } as const;
  expect(applyInputProvenanceToUserMessage(message, execution)).toEqual({
    ...message,
    provenance: execution,
    display: false,
  });
  const recorded = { ...message, provenance: execution };
  expect(applyInputProvenanceToUserMessage(recorded, undefined)).toMatchObject({ display: false });
  expect(message).not.toHaveProperty("display");
  const human = { ...message, provenance: { kind: "external_user" } as const };
  expect(applyInputProvenanceToUserMessage(human, execution)).toBe(human);
  const announcement = {
    ...message,
    provenance: { kind: "internal_system", sourceTool: "cron" } as const,
  };
  expect(applyInputProvenanceToUserMessage(announcement, execution)).toBe(announcement);
});

it.each([
  ["internal_system", "cron_execution", true],
  ["external_user", "cron_execution", false],
  ["internal_system", "cron", false],
  ["external_user", "subagent_announce", false],
  ["inter_session", "sessions_send", false],
] as const)(
  "preserves scheduled-check session state only for %s/%s",
  (kind, sourceTool, expected) => {
    expect(preserves({ kind, sourceTool })).toBe(expected);
  },
);
