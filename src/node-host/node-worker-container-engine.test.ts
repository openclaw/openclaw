import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import { runExec } from "../process/exec.js";
import {
  createNodeWorkerContainer,
  resolveNodeWorkerContainerEngine,
  type NodeWorkerContainerEngine,
} from "./node-worker-container-engine.js";

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutableFromPathEnv: vi.fn((id: string) => `/synthetic/bin/${id}`),
}));
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
      vi.mocked(runExec)
        .mockResolvedValueOnce({ stdout: "synthetic-daemon\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: '["name=seccomp"]\n', stderr: "" });
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
    expect(runExec).toHaveBeenCalledTimes(operation === "create" ? 3 : 1);
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

it("mounts an explicit private HOME without using the device folder for internal state", async () => {
  vi.mocked(runExec)
    .mockResolvedValueOnce({ stdout: "synthetic-daemon\n", stderr: "" })
    .mockResolvedValueOnce({ stdout: '["name=seccomp"]\n', stderr: "" })
    .mockResolvedValueOnce({ stdout: `${"a".repeat(64)}\n`, stderr: "" });
  await createNodeWorkerContainer(containerEngine("docker"), {
    ...launch,
    homeDir: '/synthetic/acme, "inc"/session-home',
  });
  expect(runExec).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.arrayContaining([
      'type=bind,"source=/synthetic/acme, ""inc""/session-home","target=/synthetic/acme, ""inc""/session-home"',
      'HOME=/synthetic/acme, "inc"/session-home',
      "type=bind,source=/synthetic/workspace,target=/synthetic/workspace",
    ]),
    expect.any(Object),
  );
});

describe("rootless Docker confinement", () => {
  beforeEach(() => {
    vi.mocked(resolveExecutableFromPathEnv).mockImplementation(
      (id: string) => `/synthetic/bin/${id}`,
    );
  });

  it("records authoritative rootless Docker security options", async () => {
    vi.mocked(runExec)
      .mockResolvedValueOnce({ stdout: "27.0.0\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "synthetic-daemon\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: '["name=seccomp","name=rootless"]\n', stderr: "" });

    await expect(
      resolveNodeWorkerContainerEngine({
        env: { PATH: "/synthetic/bin", DOCKER_HOST: "unix:///synthetic/docker.sock" },
      }),
    ).resolves.toMatchObject({ id: "docker", rootless: true });
  });

  it("fails closed when Docker security options are malformed", async () => {
    vi.mocked(runExec)
      .mockResolvedValueOnce({ stdout: "27.0.0\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "synthetic-daemon\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "not-json\n", stderr: "" })
      .mockRejectedValueOnce(new Error("podman unavailable"));

    await expect(
      resolveNodeWorkerContainerEngine({
        env: { PATH: "/synthetic/bin", DOCKER_HOST: "unix:///synthetic/docker.sock" },
      }),
    ).rejects.toThrow("Docker daemon returned invalid security options");
  });

  it.each([
    { rootless: true, expectedUserFlag: false },
    { rootless: false, expectedUserFlag: true },
  ])(
    "sets the Docker user only when rootless=$rootless",
    async ({ rootless, expectedUserFlag }) => {
      vi.mocked(runExec)
        .mockResolvedValueOnce({ stdout: "synthetic-daemon\n", stderr: "" })
        .mockResolvedValueOnce({
          stdout: rootless ? '["name=rootless"]\n' : '["name=seccomp"]\n',
          stderr: "",
        })
        .mockResolvedValueOnce({ stdout: `${"a".repeat(64)}\n`, stderr: "" });

      await createNodeWorkerContainer({ ...containerEngine("docker"), rootless }, launch);

      const createArgs = vi.mocked(runExec).mock.calls.at(-1)?.[1] ?? [];
      expect(createArgs.includes("--user")).toBe(expectedUserFlag);
    },
  );
});
