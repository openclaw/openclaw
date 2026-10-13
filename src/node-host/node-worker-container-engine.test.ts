import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { runExec } from "../process/exec.js";
import {
  createNodeWorkerContainer,
  type NodeWorkerContainerEngine,
} from "./node-worker-container-engine.js";

vi.mock("../process/exec.js", () => ({ runExec: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
});

const launch = {
  bundleRoot: "/synthetic/bundles",
  bundleEntry: "/synthetic/bundles/current/worker.mjs",
  workspaceDir: "/synthetic/workspace",
  gatewayNamespace: "gateway-test",
  launchId: "launch-test",
  env: { SUPPLIED_SECRET: "synthetic-private-value" },
};

function containerEngine(id: NodeWorkerContainerEngine["id"]): NodeWorkerContainerEngine {
  return {
    id,
    command: `/synthetic/private/bin/${id}`,
    target: createHash("sha256").update("docker\0synthetic-daemon").digest("hex"),
    env: { DOCKER_HOST: "unix:///synthetic/docker.sock" },
  };
}

it.each([
  { id: "docker", operation: "info", timedOut: true },
  { id: "podman", operation: "info", timedOut: true },
  { id: "docker", operation: "create", timedOut: true },
  { id: "docker", operation: "info", timedOut: false },
] as const)(
  "preserves $id $operation failure diagnostics (timeout=$timedOut)",
  async ({ id, operation, timedOut }) => {
    const failure = Object.assign(
      new Error(timedOut ? "Command timed out" : "daemon unavailable"),
      { timedOut },
    );
    if (operation === "create") {
      vi.mocked(runExec).mockResolvedValueOnce({ stdout: "synthetic-daemon\n", stderr: "" });
    }
    vi.mocked(runExec).mockRejectedValueOnce(failure);
    const engine = containerEngine(id);
    const result = createNodeWorkerContainer(engine, launch);
    const timeoutMs = operation === "create" ? 300_000 : 30_000;
    if (timedOut) {
      await expect(result).rejects.toMatchObject({
        message: `Container command timed out after ${timeoutMs} milliseconds: ${id} ${operation}`,
        cause: failure,
      });
    } else {
      await expect(result).rejects.toBe(failure);
    }
    expect(runExec).toHaveBeenCalledTimes(operation === "create" ? 2 : 1);
    expect(runExec).toHaveBeenLastCalledWith(
      engine.command,
      expect.arrayContaining(
        operation === "create"
          ? ["create", "SUPPLIED_SECRET=synthetic-private-value"]
          : ["info", "--format"],
      ),
      expect.objectContaining({ timeoutMs, logOutput: false }),
    );
  },
);
