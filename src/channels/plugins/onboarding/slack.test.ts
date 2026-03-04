import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { slackOnboardingAdapter } from "./slack.js";

function createPrompterHarness(params: { textValues: string[]; confirmValues: boolean[] }) {
  const textValues = [...params.textValues];
  const confirmValues = [...params.confirmValues];

  const intro = vi.fn(async () => undefined);
  const outro = vi.fn(async () => undefined);
  const note = vi.fn(async () => undefined);
  const select = vi.fn(async () => "allowlist");
  const multiselect = vi.fn(async () => [] as string[]);
  const text = vi.fn(async () => textValues.shift() ?? "");
  const confirm = vi.fn(async () => confirmValues.shift() ?? false);
  const progress = vi.fn(() => ({
    update: vi.fn(),
    stop: vi.fn(),
  }));

  return {
    note,
    prompter: {
      intro,
      outro,
      note,
      select,
      multiselect,
      text,
      confirm,
      progress,
    } as WizardPrompter,
  };
}

describe("slackOnboardingAdapter.configure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the Slack manifest as raw JSON instead of embedding it in note text", async () => {
    const harness = createPrompterHarness({
      textValues: ["OpenClaw Bot", "xoxb-test-token", "xapp-test-token"],
      confirmValues: [false],
    });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const result = await slackOnboardingAdapter.configure({
      cfg: {},
      runtime: {} as RuntimeEnv,
      prompter: harness.prompter,
      options: { secretInputMode: "plaintext" },
      accountOverrides: { slack: "work" },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("work");
    expect(result.cfg.channels?.slack?.accounts?.work?.botToken).toBe("xoxb-test-token");
    expect(result.cfg.channels?.slack?.accounts?.work?.appToken).toBe("xapp-test-token");

    const helpNoteCall = harness.note.mock.calls.find(
      (call) =>
        Array.isArray(call) &&
        typeof (call as unknown as [unknown, unknown])[1] === "string" &&
        (call as unknown as [unknown, unknown])[1] === "Slack socket mode tokens",
    );
    const helpNoteRaw = (helpNoteCall as unknown as [unknown, unknown] | undefined)?.[0];
    const helpNote = typeof helpNoteRaw === "string" ? helpNoteRaw : "";
    expect(helpNote).toContain('Manifest for "OpenClaw Bot" is printed below as raw JSON.');
    expect(helpNote).not.toContain('"display_information"');

    const manifestOutput = stdoutWrite.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('"display_information"'));
    expect(manifestOutput).toBeDefined();
    expect(manifestOutput).not.toContain("│");
    expect(manifestOutput?.trim().startsWith("{")).toBe(true);
  });
});
