import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createExitThrowingRuntime } from "../../test/helpers/auth-wizard.js";
import type { ChannelSetupWizardAdapter } from "../channels/plugins/setup-wizard-types.js";
import { readConfigFileSnapshot } from "../config/config.js";
import {
  createChannelOnboardingPostWriteHook,
  createChannelSetupHooks,
} from "../flows/channel-setup.js";
import { commitConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeWizardConfigFile } from "../wizard/setup.shared.js";

type AfterConfigWritten = NonNullable<ChannelSetupWizardAdapter["afterConfigWritten"]>;
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let runtime: ReturnType<typeof createExitThrowingRuntime>;
let hooks: ReturnType<typeof createChannelSetupHooks>;
beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "post-write",
    layout: "split",
    scenario: "minimal",
    env: { SETUP_REPLY_PREFIX: "resolved prefix" },
  });
  runtime = createExitThrowingRuntime();
  hooks = createChannelSetupHooks({ runtime });
});
afterEach(() => state?.cleanup());

it.each(["plugin", "wizard"] as const)(
  "resolves the exact %s commit after config selection changes",
  async (writer) => {
    const messages = { responsePrefix: "${SETUP_REPLY_PREFIX}" };
    await state.writeConfig({ messages });
    const before = await readConfigFileSnapshot();
    const next = { ...before.sourceConfig, gateway: { port: 19001 } };
    const afterConfigWritten = vi.fn<AfterConfigWritten>(async () => {});
    hooks.onPostWriteHook(
      createChannelOnboardingPostWriteHook({
        channel: "matrix",
        accountId: "ops",
        previousCfg: before.sourceConfig,
        adapter: { afterConfigWritten },
      })!,
    );
    const committed =
      writer === "plugin"
        ? await commitConfigWithPendingPluginInstalls({
            sourceConfig: next,
            baseHash: before.hash,
          })
        : await writeWizardConfigFile(next, { baseHash: before.hash });
    expect(afterConfigWritten).not.toHaveBeenCalled();
    const persisted = await readConfigFileSnapshot();
    expect(JSON.parse(persisted.raw ?? "")).toMatchObject({ messages, gateway: next.gateway });
    process.env.OPENCLAW_CONFIG_PATH = await state.writeJson("decoy.json", {});

    await hooks.runPostWriteHooks(committed.path);

    expect(afterConfigWritten.mock.lastCall?.[0]).toMatchObject({
      cfg: { messages: { responsePrefix: "resolved prefix" }, gateway: { port: 19001 } },
      accountId: "ops",
    });
    expect(afterConfigWritten.mock.lastCall?.[0].previousCfg).toEqual(before.sourceConfig);
    expect(runtime.error).not.toHaveBeenCalled();
  },
);

it("deduplicates accounts, continues after a hook warning, and clears completed hooks", async () => {
  const replaced = vi.fn();
  const failing = vi.fn().mockRejectedValue(new Error("hook failed"));
  const succeeding = vi.fn();
  hooks.onPostWriteHook({ channel: "matrix", accountId: "ops", run: replaced });
  hooks.onPostWriteHook({ channel: "matrix", accountId: "ops", run: failing });
  hooks.onPostWriteHook({ channel: "telegram", accountId: "ops", run: succeeding });

  await hooks.runPostWriteHooks(state.configPath);
  await hooks.runPostWriteHooks(state.path("missing-after-completion.json"));

  expect(replaced).not.toHaveBeenCalled();
  expect(failing).toHaveBeenCalledOnce();
  expect(succeeding).toHaveBeenCalledOnce();
  expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
    'Channel matrix post-setup warning for "ops": hook failed',
  );
});

it("rechecks authority after the awaited read and retains rejected hooks", async () => {
  let active = true;
  const hook = vi.fn();
  hooks = createChannelSetupHooks({
    runtime,
    beforePersistentEffect: async () => assert(active, "owner revoked"),
  });
  hooks.onPostWriteHook({ channel: "matrix", accountId: "ops", run: hook });
  const pending = hooks.runPostWriteHooks(state.configPath);
  active = false;

  await expect(pending).rejects.toThrow("owner revoked");
  expect(hook).not.toHaveBeenCalled();
  expect(runtime.error).not.toHaveBeenCalled();
  active = true;
  await hooks.runPostWriteHooks(state.configPath);
  expect(hook).toHaveBeenCalledOnce();
});
