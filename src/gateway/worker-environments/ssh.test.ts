import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import {
  prepareWorkerSsh,
  resolveWorkerSshSandboxSettings,
  runWorkerSshCandidates,
  workerSshOptions,
} from "./ssh.js";

const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
const SSH: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 2202,
  fallbackPorts: [22, 2200],
  user: "worker",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "workers", id: "/identity" },
};
const IDENTITY = { kind: "path", path: "/keys/worker" } as const;

const KNOWN_HOSTS = [
  `[worker.example.test]:2202 ${HOST_KEY}`,
  `worker.example.test ${HOST_KEY}`,
  `[worker.example.test]:2200 ${HOST_KEY}`,
  "",
].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function prepareTestWorkerSsh(params: Partial<Parameters<typeof prepareWorkerSsh>[0]> = {}) {
  const prepared = await prepareWorkerSsh({
    ssh: SSH,
    pinnedHostKey: SSH.hostKey,
    resolveIdentity: async () => IDENTITY,
    ...params,
  });
  onTestFinished(() => prepared.dispose());
  return prepared;
}

it.each([false, true])(
  "closes preparation authority after success or revocation (%s)",
  async (revoked) => {
    const controller = new AbortController();
    const closed = new Error("SSH preparation stopped");
    let retained: (() => void) | undefined;
    const writeFile = vi.spyOn(fs, "writeFile");
    const preparing = prepareTestWorkerSsh({
      assertCurrent: () => controller.signal.throwIfAborted(),
      resolveIdentity: async (_keyRef, context) => {
        retained = context.assertCurrent;
        context.assertCurrent();
        if (revoked) {
          controller.abort(closed);
        }
        return revoked ? { kind: "material", contents: "synthetic-worker-key" } : IDENTITY;
      },
    });
    if (revoked) {
      await expect(preparing).rejects.toBe(closed);
      expect(writeFile).not.toHaveBeenCalled();
    } else {
      await fs.access((await preparing).knownHostsPath);
    }
    expect(retained).toBeTypeOf("function");
    expect(() => retained?.()).toThrow("preparation invocation is closed");
  },
);

it("retries disposal after a filesystem cleanup failure", async () => {
  const prepared = await prepareTestWorkerSsh();
  const directory = path.dirname(prepared.knownHostsPath);
  const failure = new Error("synthetic cleanup failure");
  vi.spyOn(fs, "rm").mockRejectedValueOnce(failure);
  await expect(prepared.dispose()).rejects.toBe(failure);
  await fs.access(directory);
  await prepared.dispose();
  await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("adapts pinned endpoint identity and every advertised port for sandbox SSH", () => {
  expect(
    resolveWorkerSshSandboxSettings({
      ssh: SSH,
      identity: IDENTITY,
    }),
  ).toEqual({
    target: "worker@worker.example.test:2202",
    command: "ssh",
    strictHostKeyChecking: true,
    updateHostKeys: false,
    identityFile: "/keys/worker",
    knownHostsData: KNOWN_HOSTS,
  });
});

it("shares the pinned trust context while disabling only unrequested forwardings", async () => {
  let identityResolutions = 0;
  const prepared = await prepareTestWorkerSsh({
    resolveIdentity: async () => {
      identityResolutions += 1;
      return IDENTITY;
    },
  });
  expect(await fs.readFile(prepared.knownHostsPath, "utf8")).toBe(KNOWN_HOSTS);
  expect(identityResolutions).toBe(1);
  for (const forwarding of ["disabled", "explicit"] as const) {
    expect(workerSshOptions(prepared, { forwarding })).toEqual(
      expect.arrayContaining([
        `ClearAllForwardings=${forwarding === "disabled" ? "yes" : "no"}`,
        "StrictHostKeyChecking=yes",
        "UpdateHostKeys=no",
        "ControlMaster=no",
        "ControlPath=none",
      ]),
    );
  }
});

it("rotates stable advertised order from the selected authenticated port", async () => {
  const prepared = await prepareTestWorkerSsh();
  const attempted: number[] = [];
  await runWorkerSshCandidates(prepared, 10_000, async (port) => {
    attempted.push(port);
    return { code: port === 2202 ? 255 : 7, termination: "exit" };
  });

  expect(attempted).toEqual([2202, 22]);
  expect(prepared.port).toBe(22);
});

it.each([
  ["deadline", 2202, [2202], 100, 255, "exit"],
  ["non-exit", 22, [22, 2200], 0, null, "timeout"],
  ["exhaustion", 22, [22, 2200, 2202], 0, 255, "exit"],
] as const)(
  "retains selection after %s",
  async (_name, selected, ports, elapsed, code, termination) => {
    vi.useFakeTimers();
    const prepared = await prepareTestWorkerSsh();
    prepared.selectPort(selected);
    const attempted: number[] = [];
    const expected = { code, termination };
    const result = await runWorkerSshCandidates(prepared, 100, async (port) => {
      attempted.push(port);
      vi.advanceTimersByTime(elapsed);
      return port === selected && !elapsed ? { code: 255, termination: "exit" } : expected;
    });
    expect(result).toBe(expected);
    expect(attempted).toEqual(ports);
    expect(prepared.port).toBe(selected);
  },
);

it("materializes identity contents once and removes them with the shared context", async () => {
  const prepared = await prepareTestWorkerSsh({
    resolveIdentity: async () => ({
      kind: "material",
      contents: ["part", "value"].join("\\n"),
    }),
  });
  const identityPath = prepared.identityPath;

  expect(await fs.readFile(identityPath, "utf8")).toBe("part\nvalue\n");
  if (process.platform !== "win32") {
    expect((await fs.stat(identityPath)).mode & 0o777).toBe(0o600);
  }
  await prepared.dispose();
  await expect(fs.stat(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
});
