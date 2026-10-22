import { afterEach, expect, it, vi } from "vitest";
import { resolveInstallPolicyWarningAcknowledgementCliOptions as resolveOptions } from "./install-policy-warning-acknowledgement.ts";

const promptText = vi.hoisted(() => vi.fn());
// mock-isolation: Supply explicit acknowledgement answers without an interactive terminal prompt.
vi.mock("./prompt.js", () => ({ promptText }));
const streams = [process.stdin, process.stdout];
const originalTtys = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
function setTty(value: boolean) {
  for (const stream of streams) {
    Object.defineProperty(stream, "isTTY", { value, configurable: true });
  }
}
const warning = (targetName = "demo") => ({
  targetName,
  targetType: "plugin" as const,
  requestMode: "install" as const,
  reason: "Policy warning",
});
afterEach(() => {
  promptText.mockReset();
  streams.forEach((stream, index) => {
    const descriptor = originalTtys[index];
    if (descriptor) {
      Object.defineProperty(stream, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(stream, "isTTY");
    }
  });
});

it.each([
  ["install", "plugin", "demo\npkg", "demo\\npkg", "approved"],
  ["update", "plugin", "demo\npkg", "demo\\npkg", "approved"],
  ["install", "skill", "demo", "another-package", "declined"],
] as const)(
  "requires exact sanitized target for %s (%s)",
  async (requestMode, targetType, target, answer, status) => {
    setTty(true);
    promptText.mockResolvedValueOnce(answer);
    const request = { ...warning(target), requestMode, targetType };
    await expect(resolveOptions({}).onInstallPolicyWarning?.(request)).resolves.toEqual({ status });
    expect(promptText).toHaveBeenCalledWith(
      `type: '${target.replaceAll("\n", "\\n")}' to ${requestMode} anyway\n> `,
    );
  },
);

it.each([
  { tty: false, options: {} },
  { tty: true, options: { allowPrompt: false } },
])("requires prompt authority, tty=$tty options=$options", ({ tty, options }) => {
  setTty(tty);
  expect(resolveOptions(options)).toEqual({});
  expect(promptText).not.toHaveBeenCalled();
});

it("uses the dedicated acknowledgement flag for every warning without prompting", async () => {
  setTty(false);
  const options = resolveOptions({ acknowledgeInstallPolicyWarning: true });
  await expect(options.onInstallPolicyWarning?.(warning())).resolves.toEqual({
    status: "approved",
  });
  const dependency = { ...warning("demo-dependency"), reason: "Dependency policy warning" };
  await expect(options.onInstallPolicyWarning?.(dependency)).resolves.toEqual({
    status: "approved",
  });
  expect(promptText).not.toHaveBeenCalled();
});
