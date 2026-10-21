import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../../config/config.js";
import { testing as sessionBindingTesting } from "../../../../infra/outbound/session-binding-service.js";
import { resetPluginRuntimeStateForTest } from "../../../../plugins/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../../test-utils/openclaw-test-state.js";
import { getSessionBindingContractRegistry } from "./registry-session-binding.js";

function installSessionBindingContractSuite(
  params: ReturnType<typeof getSessionBindingContractRegistry>[number],
) {
  it("registers, binds, unbinds, and cleans up session bindings", async () => {
    expect(await Promise.resolve(params.getCapabilities())).toEqual(params.expectedCapabilities);
    const binding = await params.bindAndResolve();
    try {
      expect(typeof binding.bindingId).toBe("string");
      expect(binding.bindingId.trim()).not.toBe("");
      expect(typeof binding.targetSessionKey).toBe("string");
      expect(binding.targetSessionKey.trim()).not.toBe("");
      expect(["session", "subagent"]).toContain(binding.targetKind);
      expect(typeof binding.conversation.channel).toBe("string");
      expect(typeof binding.conversation.accountId).toBe("string");
      expect(typeof binding.conversation.conversationId).toBe("string");
      expect(["active", "ending", "ended"]).toContain(binding.status);
      expect(typeof binding.boundAt).toBe("number");
      await params.unbindAndVerify(binding);
    } finally {
      await params.cleanup();
    }
  });
}

export function describeSessionBindingRegistryBackedContract(id: string) {
  const entry = getSessionBindingContractRegistry().find((item) => item.id === id);
  if (!entry) {
    throw new Error(`missing session binding contract entry for ${id}`);
  }

  describe(`${entry.id} session binding contract`, () => {
    let testState: OpenClawTestState | undefined;

    beforeAll(async () => {
      await entry.preload?.();
    });

    beforeEach(async () => {
      testState = await createOpenClawTestState({
        label: `${entry.id}-session-binding-contract`,
        layout: "state-only",
      });
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      // Stay hermetic while enabling the config-aware bundled runtime facades.
      setRuntimeConfigSnapshot(
        id === "discord" || id === "matrix"
          ? { plugins: { entries: { [id]: { enabled: true } } } }
          : {},
      );
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
      await entry.beforeEach?.();
    });
    afterEach(async () => {
      clearRuntimeConfigSnapshot();
      await testState?.cleanup();
      testState = undefined;
    });

    installSessionBindingContractSuite(entry);
  });
}
