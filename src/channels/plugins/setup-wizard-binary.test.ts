import { describe, expect, it, vi } from "vitest";
import {
  createCliPathTextInput,
  createDelegatedTextInputShouldPrompt,
  createDetectedBinaryStatus,
} from "./setup-wizard-binary.js";
import type { ChannelSetupWizard } from "./setup-wizard.js";

const binaryLabels = {
  channelLabel: "Signal",
  binaryLabel: "signal-cli",
  configuredLabel: "configured",
  unconfiguredLabel: "needs setup",
  configuredHint: "signal-cli found",
  unconfiguredHint: "signal-cli missing",
  configuredScore: 1,
  unconfiguredScore: 0,
};
const wizardBase: ChannelSetupWizard = {
  channel: "demo",
  status: { ...binaryLabels, resolveConfigured: () => true },
  credentials: [],
};
const inputParams = { cfg: {}, accountId: "default", credentialValues: {} };
const statusParams = { cfg: {}, configured: true };

describe("setup wizard binary helpers", () => {
  it("builds status lines, hint, and score from binary detection", async () => {
    const resolveConfigured = vi.fn(() => true);
    const resolveBinaryPath = vi.fn(() => "/usr/local/bin/signal-cli");
    const status = createDetectedBinaryStatus({
      ...binaryLabels,
      resolveConfigured,
      resolveBinaryPath,
      detectBinary: vi.fn(async () => true),
    });

    expect(await status.resolveConfigured({ cfg: {}, accountId: "work" })).toBe(true);
    expect(resolveConfigured).toHaveBeenCalledWith({ cfg: {}, accountId: "work" });
    expect(await status.resolveStatusLines?.(statusParams)).toEqual([
      "Signal: configured",
      "signal-cli: found (/usr/local/bin/signal-cli)",
    ]);
    expect(resolveBinaryPath).toHaveBeenCalledWith({ cfg: {}, accountId: undefined });
    expect(await status.resolveSelectionHint?.(statusParams)).toBe("signal-cli found");
    expect(await status.resolveQuickstartScore?.(statusParams)).toBe(1);
  });

  it("passes accountId into binary path resolution", async () => {
    const resolveBinaryPath = vi.fn(({ accountId }: { accountId?: string }) =>
      accountId === "work" ? "/opt/work-signal-cli" : "/usr/local/bin/signal-cli",
    );
    const status = createDetectedBinaryStatus({
      ...binaryLabels,
      resolveConfigured: () => true,
      resolveBinaryPath,
      detectBinary: vi.fn(async () => false),
    });

    const missing = { cfg: {}, accountId: "work", configured: false };
    const lines = await status.resolveStatusLines?.(missing);
    expect(lines).toEqual(["Signal: needs setup", "signal-cli: missing (/opt/work-signal-cli)"]);
    expect(resolveBinaryPath).toHaveBeenCalledWith({ cfg: {}, accountId: "work" });
  });
  it("createCliPathTextInput reuses the same path resolver for current and initial values", async () => {
    const textInput = createCliPathTextInput({
      inputKey: "cliPath",
      message: "CLI path",
      resolvePath: () => "imsg",
      shouldPrompt: async () => false,
      helpTitle: "iMessage",
      helpLines: ["help"],
    });

    expect(await textInput.currentValue?.(inputParams)).toBe("imsg");
    expect(await textInput.initialValue?.(inputParams)).toBe("imsg");
    expect(textInput.helpTitle).toBe("iMessage");
    expect(textInput.helpLines).toEqual(["help"]);
  });
  it("createDelegatedTextInputShouldPrompt forwards shouldPrompt for the requested input key", async () => {
    const loadWizard = vi.fn(async (): Promise<ChannelSetupWizard> => ({
      ...wizardBase,
      textInputs: [
        {
          inputKey: "cliPath",
          message: "CLI path",
          shouldPrompt: async ({ currentValue }) => currentValue !== "imsg",
        },
      ],
    }));

    const shouldPrompt = createDelegatedTextInputShouldPrompt({ loadWizard, inputKey: "cliPath" });
    expect(await shouldPrompt({ ...inputParams, currentValue: "imsg" })).toBe(false);
    expect(await shouldPrompt({ ...inputParams, currentValue: "other" })).toBe(true);
  });
});
