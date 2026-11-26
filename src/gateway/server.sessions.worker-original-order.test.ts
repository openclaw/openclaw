import { expect, test } from "vitest";
import type { WorkerSshRunner } from "./worker-environments/tunnel-ssh-runner.js";
import { createWorkerTunnelManager } from "./worker-environments/tunnel.js";
import {
  PWD_COMMAND,
  startTestTunnel,
  success,
} from "./worker-environments/tunnel.test-support.js";

test("remote-exec workspace commands do not start a persistent SSH process", async () => {
  const response = success("/workspace\n");
  const runner: WorkerSshRunner = {
    start() {
      throw new Error("remote-exec must not start a persistent SSH process");
    },
    async run(argv) {
      expect(argv[0]).toBe("ssh");
      return response;
    },
  };
  const manager = createWorkerTunnelManager({ runner });
  const environmentId = "worker:no-persistent-ssh";
  try {
    const handle = await startTestTunnel(manager, environmentId, 1);
    expect(handle).toMatchObject({ environmentId, ownerEpoch: 1 });
    expect(manager.status(environmentId)).toBe("connected");
    await expect(handle.runWorkspaceCommand(PWD_COMMAND)).resolves.toMatchObject({
      stdout: "/workspace\n",
      code: 0,
    });
  } finally {
    await manager.stopAll();
  }
});
