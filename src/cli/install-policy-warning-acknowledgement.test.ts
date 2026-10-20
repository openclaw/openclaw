import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.ts";

const promptTextMock = vi.hoisted(() => vi.fn());

vi.mock("./prompt.js", () => ({
  promptText: promptTextMock,
}));

const streams = [process.stdin, process.stdout];
const originalTtys = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
const warning = (targetName = "demo") => ({
  targetName,
  targetType: "plugin" as const,
  requestMode: "install" as const,
  reason: "Policy warning",
});

function setTty(value: boolean): void {
  for (const stream of streams) {
    Object.defineProperty(stream, "isTTY", { value, configurable: true });
  }
}

describe("resolveInstallPolicyWarningAcknowledgementCliOptions", () => {
  afterEach(() => {
    promptTextMock.mockReset();
    streams.forEach((stream, index) => {
      const descriptor = originalTtys[index];
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    });
  });

  it.each(["install", "update"] as const)(
    "uses the ClawHub suspicious-warning copy for %s",
    async (requestMode) => {
      setTty(true);
      promptTextMock.mockResolvedValueOnce("demo\\npkg");

      const options = resolveInstallPolicyWarningAcknowledgementCliOptions({});
      await expect(
        options.onInstallPolicyWarning?.({
          ...warning("demo\npkg"),
          requestMode,
        }),
      ).resolves.toEqual({ status: "approved" });

      expect(promptTextMock).toHaveBeenCalledWith(
        `type: 'demo\\npkg' to ${requestMode} anyway\n> `,
      );
    },
  );

  it("requires the exact target name", async () => {
    setTty(true);
    promptTextMock.mockResolvedValueOnce("another-package");

    const options = resolveInstallPolicyWarningAcknowledgementCliOptions({});

    await expect(
      options.onInstallPolicyWarning?.({ ...warning(), targetType: "skill" }),
    ).resolves.toEqual({ status: "declined" });
  });

  it("does not prompt outside a TTY", () => {
    setTty(false);
    expect(resolveInstallPolicyWarningAcknowledgementCliOptions({})).toEqual({});
  });

  it("does not infer prompt authority from an attached TTY", () => {
    setTty(true);
    expect(resolveInstallPolicyWarningAcknowledgementCliOptions({ allowPrompt: false })).toEqual(
      {},
    );
    expect(promptTextMock).not.toHaveBeenCalled();
  });

  it("uses the dedicated acknowledgement flag for every warning without prompting", async () => {
    setTty(false);
    const options = resolveInstallPolicyWarningAcknowledgementCliOptions({
      acknowledgeInstallPolicyWarning: true,
    });

    await expect(options.onInstallPolicyWarning?.(warning())).resolves.toEqual({
      status: "approved",
    });
    await expect(
      options.onInstallPolicyWarning?.({
        ...warning("demo-dependency"),
        reason: "Dependency policy warning",
      }),
    ).resolves.toEqual({ status: "approved" });
    expect(promptTextMock).not.toHaveBeenCalled();
  });
});
