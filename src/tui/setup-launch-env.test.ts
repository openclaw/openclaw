import { describe, expect, it } from "vitest";
import {
  consumeTuiSetupExtraSystemPrompt,
  TUI_SETUP_EXTRA_SYSTEM_PROMPT_ENV,
} from "./setup-launch-env.js";

describe("consumeTuiSetupExtraSystemPrompt", () => {
  it("consumes runtime-only setup instructions for a local TUI", () => {
    const env = {
      [TUI_SETUP_EXTRA_SYSTEM_PROMPT_ENV]: "  Use official channel setup instructions.  ",
    };

    expect(consumeTuiSetupExtraSystemPrompt({ local: true, env })).toBe(
      "Use official channel setup instructions.",
    );
    expect(env).not.toHaveProperty(TUI_SETUP_EXTRA_SYSTEM_PROMPT_ENV);
  });

  it("does not expose setup instructions to a gateway TUI", () => {
    const env = {
      [TUI_SETUP_EXTRA_SYSTEM_PROMPT_ENV]: "Use official channel setup instructions.",
    };

    expect(consumeTuiSetupExtraSystemPrompt({ local: false, env })).toBeUndefined();
    expect(env).toHaveProperty(TUI_SETUP_EXTRA_SYSTEM_PROMPT_ENV);
  });
});
