import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { slackOnboardingAdapter } from "./slack.js";

function createPrompterHarness(params: { textValues: string[]; confirmValues: boolean[] }) {
  const textValues = [...params.textValues];
  const confirmValues = [...params.confirmValues];

  const note = vi.fn<WizardPrompter["note"]>(async () => undefined);
  const text = vi.fn<WizardPrompter["text"]>(async () => textValues.shift() ?? "");
  const confirm = vi.fn<WizardPrompter["confirm"]>(async () => confirmValues.shift() ?? false);

  return {
    note,
    text,
    confirm,
    prompter: {
      note,
      text,
      confirm,
    } as Pick<WizardPrompter, "note" | "text" | "confirm"> as WizardPrompter,
  };
}

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("slackOnboardingAdapter.configure", () => {
  it("includes DM and assistant scopes in the generated Slack manifest", async () => {
    const harness = createPrompterHarness({
      textValues: ["OpenClaw", "xoxb-test", "xapp-test"],
      confirmValues: [false],
    });

    const result = await slackOnboardingAdapter.configure({
      cfg: {},
      runtime: createRuntime(),
      prompter: harness.prompter,
      options: {
        secretInputMode: "plaintext",
      },
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.cfg.channels?.slack?.botToken).toBe("xoxb-test");
    expect(result.cfg.channels?.slack?.appToken).toBe("xapp-test");
    expect(harness.note).toHaveBeenCalledTimes(1);

    const [manifestNote] = harness.note.mock.calls[0] ?? [];
    expect(manifestNote).toContain('"im:read"');
    expect(manifestNote).toContain('"im:write"');
    expect(manifestNote).toContain('"mpim:read"');
    expect(manifestNote).toContain('"mpim:write"');
    expect(manifestNote).toContain('"assistant:write"');
    expect(manifestNote).toContain('"message.im"');
    expect(manifestNote).toContain('"message.mpim"');
    expect(manifestNote).toContain('"messages_tab_enabled": true');
  });
});
