import { expect, it } from "vitest";
import { prepareServiceChildRelay } from "./service-child-relay-preparation.js";

// Regression for #191841: on Linux hosts whose native child-reaping binding is
// unavailable (glibc < 2.31, e.g. RHEL 8 / CentOS 8 / Alibaba Cloud Linux 3),
// the host must decide against the linux-subreaper anchor and fall back to
// standard POSIX process-group supervision. Before the fix the host always
// picked the subreaper path on Linux x64, the anchor then failed with
// "native child reaping is unavailable", and every child spawn hard-failed.
it.skipIf(process.platform !== "linux")(
  "falls back to POSIX process-group supervision when native child reaping is unavailable",
  () => {
    const previous = process.env.PROC_SAFE_NATIVE;
    process.env.PROC_SAFE_NATIVE = "off";
    try {
      const preparation = prepareServiceChildRelay({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        stdinMode: "pipe-closed",
        oomScoreWrapperSelected: false,
      });
      expect(preparation.useLinuxSubreaper).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.PROC_SAFE_NATIVE;
      } else {
        process.env.PROC_SAFE_NATIVE = previous;
      }
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "spawns a child via the process-group fallback when native child reaping is unavailable",
  async () => {
    const previous = process.env.PROC_SAFE_NATIVE;
    process.env.PROC_SAFE_NATIVE = "off";
    try {
      const { createServiceChildRelayAdapter } = await import("./service-child-relay-host.js");
      const { adapter, ready } = await createServiceChildRelayAdapter({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("fallback-ok")'],
        stdinMode: "pipe-closed",
        oomScoreWrapperSelected: false,
      });
      await ready;
      let stdout = "";
      adapter.onStdout((chunk) => {
        stdout += chunk;
      });
      const result = await adapter.wait();
      await adapter.waitForExtinction();
      expect(stdout).toBe("fallback-ok");
      expect(adapter.treeOwnership).not.toBe("linux-subreaper");
      expect(result).toMatchObject({ code: 0, signal: null });
    } finally {
      if (previous === undefined) {
        delete process.env.PROC_SAFE_NATIVE;
      } else {
        process.env.PROC_SAFE_NATIVE = previous;
      }
    }
  },
);
