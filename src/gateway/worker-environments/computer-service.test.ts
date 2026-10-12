import { afterEach, expect, it } from "vitest";
import {
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { prepareWedgedAttachedComputer } from "./computer-service.test-support.js";

afterEach(() => {
  resetAgentRunRegistryForTest();
  resetPluginRuntimeStateForTest();
});

it("settles a wedged attached computer only through a dedicated machine's confirmed destruction", async () => {
  const { h, computers, environmentId, ownerEpoch } = await prepareWedgedAttachedComputer();
  try {
    // Shared and unknown hosts retain the machine, so their stop still needs the release.
    await expect(computers.closeEnvironment(environmentId, ownerEpoch)).rejects.toThrow(
      "Attached computer cleanup failed",
    );

    await computers.closeEnvironment(environmentId, ownerEpoch, "provider-destroying");
    expect(h.options.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Attached computer cleanup failed.*DriverError\.Tool/),
    );
    // Unconfirmed destruction keeps the owner for the next teardown attempt.
    await expect(computers.closeEnvironment(environmentId, ownerEpoch)).rejects.toThrow(
      "Attached computer cleanup failed",
    );

    await computers.closeEnvironment(environmentId, ownerEpoch, "provider-destroyed");
    await expect(computers.closeEnvironment(environmentId, ownerEpoch)).resolves.toBeUndefined();
  } finally {
    await computers.close().catch(() => {});
    releaseAgentRunDelegatedAuthority(h.authority);
  }
});
