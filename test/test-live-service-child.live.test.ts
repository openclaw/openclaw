import { expect, it } from "vitest";
import { createServiceChildRelayAdapter } from "../src/process/supervisor/service-child-relay-host.js";

it.skipIf(process.platform !== "linux" || Boolean(process.versions.bun))(
  "starts and retires a native service child through the live runner",
  async () => {
    const { adapter, ready } = await createServiceChildRelayAdapter({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("native-live-output")'],
      stdinMode: "pipe-closed",
      oomScoreWrapperSelected: false,
    });
    let output = "";
    adapter.onStdout((chunk) => {
      output += chunk;
    });
    try {
      await ready;
      await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
      await adapter.waitForExtinction();
      expect(output).toBe("native-live-output");
      expect(adapter.treeOwnership).toBe("linux-subreaper");
      expect(adapter.confirmExtinction()).toBe(true);
    } finally {
      adapter.kill("SIGKILL");
      await adapter.waitForExtinction();
      adapter.dispose();
    }
  },
);
