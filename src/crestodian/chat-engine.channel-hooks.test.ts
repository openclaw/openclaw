import { describe, expect, it, vi } from "vitest";
import { CrestodianChatEngine } from "./chat-engine.js";

const mocks = vi.hoisted(() => {
  const hook = { channel: "matrix", accountId: "default", run: vi.fn() };
  return {
    hook,
    writeWizardConfigFile: vi.fn(async () => ({
      channels: { matrix: { enabled: true, committed: true } },
    })),
    runCollectedChannelOnboardingPostWriteHooks: vi.fn(async () => {}),
    setupChannels: vi.fn(async (_cfg, _runtime, _prompter, options) => {
      options?.onPostWriteHook?.(hook);
      return { channels: { matrix: { enabled: true } } };
    }),
  };
});

vi.mock("../wizard/setup.shared.js", () => ({
  readSetupConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    config: {},
    sourceConfig: {},
  })),
  writeWizardConfigFile: mocks.writeWizardConfigFile,
}));

vi.mock("../commands/onboard-channels.js", () => ({
  createChannelOnboardingPostWriteHookCollector: () => {
    const hooks: unknown[] = [];
    return {
      collect: (hook: unknown) => hooks.push(hook),
      drain: () => hooks.splice(0),
    };
  },
  runCollectedChannelOnboardingPostWriteHooks: mocks.runCollectedChannelOnboardingPostWriteHooks,
  setupChannels: mocks.setupChannels,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config: {},
    sourceConfig: {},
    issues: [],
  })),
}));

describe("Crestodian chat channel setup", () => {
  it("runs collected channel hooks after writing config", async () => {
    const engine = new CrestodianChatEngine({ yes: true });

    const reply = await engine.handle("connect matrix");

    expect(reply.text).toContain("matrix is configured");
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
      { channels: { matrix: { enabled: true } } },
      { allowConfigSizeDrop: false },
    );
    expect(mocks.runCollectedChannelOnboardingPostWriteHooks).toHaveBeenCalledWith({
      hooks: [mocks.hook],
      cfg: { channels: { matrix: { enabled: true, committed: true } } },
      runtime: expect.any(Object),
    });
  });
});
