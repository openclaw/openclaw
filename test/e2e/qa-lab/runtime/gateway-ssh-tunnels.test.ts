import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotGatewayStartupEnv } from "../../../../src/gateway/test-helpers.env.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { waitForDead } from "../../../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { runGatewaySshTunnels, sshTrustPreparedMarker } from "./gateway-ssh-tunnels.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describeOnTestbox = process.env.OPENCLAW_TESTBOX === "1" ? describe : describe.skip;
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const producerPath = path.resolve(process.cwd(), "test/e2e/qa-lab/runtime/gateway-ssh-tunnels.ts");
const accountKnownHostsPath = path.join(os.userInfo().homedir, ".ssh", "known_hosts");
const producerReadyMarker = "OPENCLAW_QA_PRODUCER_READY";
const execFile = promisify(execFileCallback);
const producerChildSource = `
import { runGatewaySshTunnels } from ${JSON.stringify(pathToFileURL(producerPath).href)};
const startSignal = new Promise((resolve) => process.stdin.once("data", resolve));
process.stdout.write("${producerReadyMarker}\\n");
await startSignal;
const evidence = await runGatewaySshTunnels(JSON.parse(process.env.OPENCLAW_QA_PRODUCER_OPTIONS));
process.exitCode = evidence.entries[0]?.result.status === "pass" ? 0 : 1;
`;

it("records blocked evidence outside Testbox without privileged setup", async () => {
  const artifactBase = tempDirs.make("openclaw-gateway-ssh-guard-");
  const evidence = await withEnvAsync({ OPENCLAW_TESTBOX: undefined }, async () =>
    runGatewaySshTunnels({ artifactBase, repoRoot: process.cwd() }),
  );

  expect(evidence.entries[0]?.result).toMatchObject({ status: "blocked" });
  await expect(fs.access(path.join(artifactBase, ".ssh-namespace"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

async function terminateChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await once(child, "close");
}

afterEach(async () => {
  await Promise.all(Array.from(activeChildren, terminateChild));
  activeChildren.clear();
});

function startProducer(
  artifactBase: string,
  fixture?: { processPath: string; readyPath: string; root: string },
) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", producerChildSource],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_QA_PRODUCER_OPTIONS: JSON.stringify({
          artifactBase,
          repoRoot: process.cwd(),
          fixtureProcessPath: fixture?.processPath,
          fixtureReadyPath: fixture?.readyPath,
          fixtureRoot: fixture?.root,
        }),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  activeChildren.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  const ready = createDeferred();
  const trustPrepared = createDeferred();
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    if (stdout.includes(producerReadyMarker)) {
      ready.resolve();
    }
    if (stdout.includes(sshTrustPreparedMarker)) {
      trustPrepared.resolve();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const completion = once(child, "close")
    .then(([code, signal]) => {
      activeChildren.delete(child);
      if (code !== 0) {
        throw new Error(
          `Gateway SSH tunnel producer exited ${code ?? "null"}/${signal ?? "none"}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
    })
    .catch((error: unknown) => {
      ready.reject(error);
      throw error;
    });
  void completion.catch(() => {});
  return {
    completion,
    kill: () => terminateChild(child),
    ready: ready.promise,
    start: () => child.stdin.end("start\n"),
    waitForTrustPrepared: () =>
      awaitGateBeforeSettlement(
        trustPrepared.promise,
        completion,
        `timeout waiting for ${fixture?.readyPath}`,
      ),
  };
}

function producerFixture(name: string, failReadiness = false) {
  const artifactBase = tempDirs.make(`openclaw-gateway-ssh-${name}-`);
  const fixture = {
    root: tempDirs.make(`openclaw-gateway-ssh-${name}-root-`),
    processPath: path.join(artifactBase, "namespace-pid"),
    readyPath: failReadiness ? artifactBase : path.join(artifactBase, "trust-prepared"),
  };
  return { artifactBase, ...fixture, producer: startProducer(artifactBase, fixture) };
}

async function killPrivilegedProcessGroup(pid: number) {
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    await execFile("/bin/kill", ["-KILL", "--", `-${pid}`]);
    return;
  }
  await execFile("/usr/bin/sudo", ["-n", "--", "/bin/kill", "-KILL", "--", `-${pid}`]);
}

async function readSummary(artifactBase: string) {
  return JSON.parse(
    await fs.readFile(path.join(artifactBase, "gateway-ssh-tunnels-summary.json"), "utf8"),
  ) as {
    cleanupReleased?: boolean;
    knownHostsIsolated?: boolean;
    hostKeyDiagnostic?: string;
    unreachableDiagnostic?: string;
  };
}

async function readOptionalFile(filePath: string) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

describeOnTestbox("Gateway SSH tunnel QA producer", () => {
  it("keeps overlapping and killed producers isolated from account SSH state", async ({
    signal,
  }) => {
    const gatewayStartupEnv = snapshotGatewayStartupEnv();
    const accountKnownHostsBefore = await readOptionalFile(accountKnownHostsPath);
    const artifacts = ["first", "second"].map((id) =>
      tempDirs.make(`openclaw-gateway-ssh-overlap-${id}-`),
    );
    const producer = startProducer(artifacts[1]!);
    await producer.ready;
    producer.start();
    const [evidence] = await Promise.all([
      runGatewaySshTunnels({ artifactBase: artifacts[0]!, repoRoot: process.cwd() }),
      producer.completion,
    ]);
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]?.result.status).toBe("pass");
    const summaries = await Promise.all(artifacts.map(readSummary));
    for (const summary of summaries) {
      expect(summary).toMatchObject({
        cleanupReleased: true,
        knownHostsIsolated: true,
        hostKeyDiagnostic: expect.stringMatching(
          /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i,
        ),
        unreachableDiagnostic: expect.stringMatching(
          /Connection refused|connect to host|ssh exited/i,
        ),
      });
    }
    expect(snapshotGatewayStartupEnv()).toEqual(gatewayStartupEnv);
    expect(await readOptionalFile(accountKnownHostsPath)).toEqual(accountKnownHostsBefore);

    const { producer: killed, processPath: killedProcessPath } = producerFixture("killed");
    await killed.ready;
    killed.start();
    await withinTest(killed.waitForTrustPrepared(), signal);
    const namespacePid = Number.parseInt(await fs.readFile(killedProcessPath, "utf8"), 10);
    expect(namespacePid).toBeGreaterThan(1);
    await killPrivilegedProcessGroup(namespacePid);
    await expect(killed.completion).rejects.toThrow(
      "namespaced Gateway SSH tunnel producer exited null/SIGKILL",
    );

    for (const failureMode of ["readiness-write", "parent-exit"]) {
      const {
        artifactBase,
        root,
        processPath,
        producer: failed,
      } = producerFixture(failureMode, failureMode === "readiness-write");
      await failed.ready;
      failed.start();
      if (failureMode === "parent-exit") {
        await withinTest(failed.waitForTrustPrepared(), signal);
        const pid = Number.parseInt(await fs.readFile(processPath, "utf8"), 10);
        expect(pid).toBeGreaterThan(1);
        await failed.kill();
        // SIGKILL removes the namespace's ChildProcess owner; only its PID remains.
        await waitForDead(pid, signal);
      } else {
        await expect(failed.completion).rejects.toThrow(
          "Gateway SSH tunnel producer exited 1/none",
        );
      }
      const failureEvidence: Awaited<ReturnType<typeof runGatewaySshTunnels>> = JSON.parse(
        await fs.readFile(path.join(artifactBase, "qa-evidence.json"), "utf8"),
      );
      expect(failureEvidence.entries[0]?.result).toMatchObject({
        status: "fail",
        failure: {
          reason: expect.stringContaining(
            failureMode === "readiness-write" ? "EISDIR" : "lost its parent before termination",
          ),
        },
      });
      await expect(fs.access(root)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readOptionalFile(accountKnownHostsPath)).toEqual(accountKnownHostsBefore);
  }, 180_000);
});
