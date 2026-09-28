import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("container command timeout diagnostics", () => {
  it.each(["docker", "podman"] as const)(
    "identifies %s revalidation and its deadline without launching a container",
    async (id) => {
      const timeout = Object.assign(new Error("Command timed out"), { timedOut: true });
      vi.mocked(runExec).mockRejectedValue(timeout);
      const engine = containerEngine(id);

      await expect(createNodeWorkerContainer(engine, launch)).rejects.toMatchObject({
        message: `Container command timed out after 30000 milliseconds: ${id} info`,
        cause: timeout,
      });
      expect(runExec).toHaveBeenCalledExactlyOnceWith(
        engine.command,
        expect.arrayContaining(["info", "--format"]),
        expect.objectContaining({ timeoutMs: 30_000, logOutput: false }),
      );
    },
  );

  it("omits private creation arguments while retaining the original timeout cause", async () => {
    const timeout = Object.assign(new Error("Command timed out"), { timedOut: true });
    vi.mocked(runExec)
      .mockResolvedValueOnce({ stdout: "synthetic-daemon\n", stderr: "" })
      .mockRejectedValueOnce(timeout);
    const engine = containerEngine("docker");

    await expect(createNodeWorkerContainer(engine, launch)).rejects.toMatchObject({
      message: "Container command timed out after 300000 milliseconds: docker create",
      cause: timeout,
    });
    expect(runExec).toHaveBeenCalledTimes(2);
    expect(runExec).toHaveBeenLastCalledWith(
      engine.command,
      expect.arrayContaining(["create", "SUPPLIED_SECRET=synthetic-private-value"]),
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it("preserves a non-timeout command failure unchanged", async () => {
    const failure = Object.assign(new Error("daemon unavailable"), { timedOut: false });
    vi.mocked(runExec).mockRejectedValue(failure);

    await expect(createNodeWorkerContainer(containerEngine("docker"), launch)).rejects.toBe(
      failure,
    );
    expect(runExec).toHaveBeenCalledOnce();
  });
});
