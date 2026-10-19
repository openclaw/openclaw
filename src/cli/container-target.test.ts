import type { spawnSync as nodeSpawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";

const childProcessMocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: childProcessMocks.spawnSync }));

const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => {
  vi.unstubAllEnvs();
  for (const [stream, descriptor] of [
    [process.stdin, stdinTty],
    [process.stdout, stdoutTty],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(stream, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(stream, "isTTY");
    }
  }
});

const hostRoutingEnv = {
  OPENCLAW_PROFILE: "work",
  OPENCLAW_GATEWAY_PORT: "19001",
  OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
  OPENCLAW_GATEWAY_TOKEN: "token",
  OPENCLAW_GATEWAY_PASSWORD: "password",
};

function runTarget(
  spawnSync?: SpawnMock,
  env: NodeJS.ProcessEnv = {},
  args = ["status"],
  tty = false,
) {
  for (const name of [
    "OPENCLAW_CONTAINER",
    "OPENCLAW_CLI_CONTAINER_BYPASS",
    "OPENCLAW_PROXY_URL",
    "OPENCLAW_CONTAINER_ALLOW_LOOPBACK_PROXY_URL",
    ...Object.keys(hostRoutingEnv),
  ]) {
    vi.stubEnv(name, undefined);
  }
  for (const [name, value] of Object.entries({
    ...(args.includes("--container") ? {} : { OPENCLAW_CONTAINER: "demo" }),
    ...env,
  })) {
    vi.stubEnv(name, value);
  }
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: tty });
  }
  childProcessMocks.spawnSync.mockReset();
  if (spawnSync) {
    childProcessMocks.spawnSync.mockImplementation(spawnSync);
  }
  return maybeRunCliInContainer(["node", "openclaw", ...args]);
}

function requireSpawnCall(
  spawnSync: ReturnType<typeof vi.fn>,
  index: number,
): [string, string[], unknown?] {
  const call = spawnSync.mock.calls[index];
  if (!call) {
    throw new Error(`Expected spawnSync call ${index}`);
  }
  return call as [string, string[], unknown?];
}

type SpawnResult = {
  status: number | null;
  stdout?: string;
  signal?: NodeJS.Signals;
  error?: Error;
};
type SpawnMock = ReturnType<typeof vi.fn> & typeof nodeSpawnSync;

const runningContainer = { status: 0, stdout: "true\n" };
const missingContainer = { status: 1, stdout: "" };
const successfulExec = { status: 0, stdout: "" };
const probeOptions = { encoding: "utf8", killSignal: "SIGKILL", timeout: 10_000 };

function mockSpawn(...results: SpawnResult[]): SpawnMock {
  const spawnSync = vi.fn();
  for (const result of results) {
    spawnSync.mockReturnValueOnce(result);
  }
  return spawnSync as SpawnMock;
}

function expectRuntimeProbes(spawnSync: SpawnMock): void {
  for (const [index, runtime] of ["podman", "docker"].entries()) {
    expect(spawnSync).toHaveBeenNthCalledWith(
      index + 1,
      runtime,
      ["inspect", "--format", "{{.State.Running}}", "demo"],
      probeOptions,
    );
  }
}

function expectContainerExec(
  spawnSync: SpawnMock,
  {
    runtime = "podman",
    argv = ["status"],
    tty = false,
    proxyUrl,
    env,
  }: {
    runtime?: "podman" | "docker";
    argv?: string[];
    tty?: boolean;
    proxyUrl?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  const envFlag = runtime === "docker" ? "-e" : "--env";
  expect(spawnSync).toHaveBeenNthCalledWith(
    3,
    runtime,
    [
      "exec",
      "-i",
      ...(tty ? ["-t"] : []),
      envFlag,
      "OPENCLAW_CONTAINER_HINT=demo",
      envFlag,
      "OPENCLAW_CLI_CONTAINER_BYPASS=1",
      ...(proxyUrl ? [envFlag, `OPENCLAW_PROXY_URL=${proxyUrl}`] : []),
      "demo",
      "openclaw",
      ...argv,
    ],
    {
      stdio: "inherit",
      env: expect.objectContaining({ ...env, OPENCLAW_CONTAINER: "" }),
    },
  );
}

describe("parseCliContainerArgs", () => {
  it("accepts the equals form", () => {
    expect(parseCliContainerArgs(["node", "openclaw", "--container=demo", "health"])).toEqual({
      ok: true,
      container: "demo",
      argv: ["node", "openclaw", "health"],
    });
  });

  it("rejects a missing container value", () => {
    expect(parseCliContainerArgs(["node", "openclaw", "--container"])).toEqual({
      ok: false,
      error: "--container requires a value",
    });
  });

  it("stops parsing --container after the -- terminator", () => {
    const childCommand = ["docker", "run", "--container", "demo", "alpine"];
    const argv = ["node", "openclaw", "nodes", "run", "--", ...childCommand];
    expect(parseCliContainerArgs([...argv])).toEqual({ ok: true, container: null, argv });
  });
});

describe("maybeRunCliInContainer", () => {
  it("passes through when no container target is provided", () => {
    expect(runTarget(undefined, { OPENCLAW_CONTAINER: undefined })).toEqual({
      handled: false,
      argv: ["node", "openclaw", "status"],
    });
  });

  it("preserves exit code 143 when the container child returns SIGTERM", () => {
    const spawnSync = mockSpawn(runningContainer, missingContainer, {
      status: null,
      signal: "SIGTERM",
    });
    expect(runTarget(spawnSync)).toEqual({ handled: true, exitCode: 143 });
  });

  it("throws the original ENOENT launch error from the container exec", () => {
    const code = "ENOENT";
    const launchError = Object.assign(new Error(`spawnSync podman ${code}`), { code });
    const spawnSync = mockSpawn(runningContainer, missingContainer, {
      status: null,
      error: launchError,
    });

    let thrown: unknown;
    try {
      runTarget(spawnSync);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(launchError);
  });

  it("clears inherited host routing and gateway env before execing into the child CLI", () => {
    const spawnSync = mockSpawn(runningContainer, missingContainer, successfulExec);

    runTarget(spawnSync, hostRoutingEnv);

    expectContainerExec(spawnSync);
    const childOptions = requireSpawnCall(spawnSync, 2)[2] as { env: NodeJS.ProcessEnv };
    for (const name of Object.keys(hostRoutingEnv)) {
      expect(childOptions.env).not.toHaveProperty(name);
    }
  });

  it("passes the proxy URL env fallback into the child container CLI", () => {
    const spawnSync = mockSpawn(runningContainer, missingContainer, successfulExec);

    runTarget(spawnSync, { OPENCLAW_PROXY_URL: " http://proxy.internal:3128 " });

    expectContainerExec(spawnSync, {
      proxyUrl: "http://proxy.internal:3128",
      env: { OPENCLAW_PROXY_URL: " http://proxy.internal:3128 " },
    });
  });

  it.each(["http://localhost.:3128", "http://[::1]:3128", "http://[::ffff:127.0.0.1]:3128"])(
    "fails before forwarding loopback proxy URL %s into a child container CLI",
    (proxyUrl) => {
      const spawnSync = mockSpawn(runningContainer, missingContainer);

      expect(() => runTarget(spawnSync, { OPENCLAW_PROXY_URL: ` ${proxyUrl} ` })).toThrow(
        "127.0.0.1 inside a container points at the container",
      );

      expect(spawnSync).toHaveBeenCalledTimes(2);
    },
  );

  it("redacts proxy URL credentials and URL suffixes before rejecting loopback container proxy forwarding", () => {
    const spawnSync = mockSpawn(runningContainer, missingContainer);

    let message = "";
    try {
      runTarget(spawnSync, {
        OPENCLAW_PROXY_URL:
          "http://proxy-user:proxy-secret@127.1:3128?token=proxy-query-secret#proxy-fragment-secret",
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("OPENCLAW_PROXY_URL=http://redacted:redacted@127.0.0.1:3128/");
    expect(message).not.toMatch(
      /proxy-user|proxy-secret|proxy-query-secret|proxy-fragment-secret|\?token=|#/,
    );
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it("allows explicitly overridden loopback proxy URL forwarding into a child container CLI", () => {
    const spawnSync = mockSpawn(runningContainer, missingContainer, successfulExec);

    runTarget(spawnSync, {
      OPENCLAW_PROXY_URL: " http://127.0.0.1:3128 ",
      OPENCLAW_CONTAINER_ALLOW_LOOPBACK_PROXY_URL: "1",
    });

    const podmanCall = requireSpawnCall(spawnSync, 2);
    expect(podmanCall[0]).toBe("podman");
    expect(podmanCall[1]).toContain("OPENCLAW_PROXY_URL=http://127.0.0.1:3128");
    expect(podmanCall[2]).toBeDefined();
  });

  it("checks docker after podman and before failing", () => {
    const spawnSync = mockSpawn(missingContainer, runningContainer, successfulExec, successfulExec);

    expect(runTarget(spawnSync, { USER: "somalley" }, ["--container", "demo", "status"])).toEqual({
      handled: true,
      exitCode: 0,
    });

    expectRuntimeProbes(spawnSync);
    expectContainerExec(spawnSync, { runtime: "docker", env: { USER: "somalley" } });
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it("does not try any sudo podman fallback for regular users", () => {
    const spawnSync = mockSpawn(missingContainer, missingContainer);

    expect(() =>
      runTarget(spawnSync, { USER: "somalley" }, ["--container", "demo", "status"]),
    ).toThrow('No running container matched "demo" under podman or docker.');

    expect(spawnSync).toHaveBeenCalledTimes(2);
    expectRuntimeProbes(spawnSync);
  });

  it("rejects ambiguous matches across runtimes", () => {
    const spawnSync = mockSpawn(runningContainer, runningContainer, missingContainer);

    expect(() =>
      runTarget(spawnSync, { USER: "somalley" }, ["--container", "demo", "status"]),
    ).toThrow(
      'Container "demo" is running under multiple runtimes (podman, docker); use a unique container name.',
    );
  });

  it("allocates a tty for interactive terminal sessions", () => {
    const spawnSync = mockSpawn(runningContainer, missingContainer, successfulExec);

    runTarget(spawnSync, {}, ["--container", "demo", "setup"], true);

    expectContainerExec(spawnSync, { argv: ["setup"], tty: true });
  });

  it("skips recursion when the bypass env is set", () => {
    expect(
      runTarget(undefined, { OPENCLAW_CLI_CONTAINER_BYPASS: "1" }, [
        "--container",
        "demo",
        "status",
      ]),
    ).toEqual({
      handled: false,
      argv: ["node", "openclaw", "--container", "demo", "status"],
    });
  });

  it.each([
    ["update after interleaved root flags", ["--no-color", "update"]],
    ["the --update shorthand", ["--update"]],
  ] as const)("blocks %s inside the container", (_name, args) => {
    const spawnSync = mockSpawn(runningContainer);
    expect(() => runTarget(spawnSync, {}, ["--container", "demo", ...args])).toThrow(
      "openclaw update is not supported with --container; rebuild or restart the container image instead.",
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
