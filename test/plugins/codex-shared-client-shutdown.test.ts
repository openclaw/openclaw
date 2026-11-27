import { expect, it } from "vitest";
import { loadCodexSharedClientShutdownTestFixture } from "../../extensions/codex/test-api.js";
import { drainGlobalSingletonLifecycleState } from "../../src/shared/global-singleton.js";

it("closes the native shared Codex client on Gateway shutdown without a registered harness", async () => {
  const { withSharedCodexClientForShutdownTest } = await loadCodexSharedClientShutdownTestFixture();
  await withSharedCodexClientForShutdownTest(async (transport) => {
    expect(transport.stdinDestroyed).toBe(false);
    await drainGlobalSingletonLifecycleState("close");
    expect(transport.stdinDestroyed).toBe(true);
  });
});
