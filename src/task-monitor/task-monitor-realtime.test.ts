import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = "/Users/server/prontoclaw";
const HEALTH_TIMEOUT_MS = 15_000;
const WATCH_SETTLE_MS = 800;

type MonitorHandle = {
  child: ChildProcess;
  homeDir: string;
  logPath: string;
  timeFilePath: string;
  port: number;
  stdout: string[];
  stderr: string[];
};

const activeHandles = new Set<MonitorHandle>();

afterEach(async () => {
  await Promise.all([...activeHandles].map(async (handle) => stopMonitor(handle)));
  activeHandles.clear();
});

describe("task-monitor realtime event/cache behavior", () => {
  it("parses an event completed across two file writes without losing the line", async () => {
    const initialEvent = {
      type: "task.started",
      agentId: "eden",
      ts: Date.UTC(2026, 2, 8, 11, 0, 0),
      data: {
        taskId: "task_seed",
        workSessionId: "ws_seed",
      },
    };

    const monitor = await startMonitor({
      seedEvents: [initialEvent],
      fakeNowMs: initialEvent.ts + 30_000,
    });

    const splitEvent = JSON.stringify({
      type: "task.completed",
      agentId: "seum",
      ts: Date.UTC(2026, 2, 8, 11, 0, 5),
      data: {
        taskId: "task_split",
        workSessionId: "ws_split",
      },
    });

    const splitAt = Math.floor(splitEvent.length / 2);
    await fs.appendFile(monitor.logPath, splitEvent.slice(0, splitAt), "utf8");
    await sleep(WATCH_SETTLE_MS);
    await fs.appendFile(monitor.logPath, `${splitEvent.slice(splitAt)}\n`, "utf8");
    await sleep(WATCH_SETTLE_MS);

    const payload = await getJson<{ events: Array<{ ts: number; type: string }>; total: number }>(
      monitor.port,
      "/api/events?limit=5",
    );

    expect(payload.total).toBe(2);
    expect(payload.events.some((event) => event.type === "task.completed")).toBe(true);
    expect(payload.events.some((event) => event.ts === Date.UTC(2026, 2, 8, 11, 0, 5))).toBe(true);
  });

  it("does not keep work sessions ACTIVE after the cache ages past the archive window", async () => {
    const baseTs = Date.UTC(2026, 2, 8, 11, 10, 0);
    const workSessionId = "ws_cache_bug";

    const monitor = await startMonitor({
      seedEvents: [
        {
          type: "a2a.send",
          agentId: "ruda",
          ts: baseTs,
          data: {
            workSessionId,
            conversationId: "conv-cache-bug",
            fromAgent: "ruda",
            toAgent: "eden",
            eventRole: "conversation.main",
            message: "please handle this",
          },
        },
      ],
      fakeNowMs: baseTs + 60_000,
    });

    const initial = await getJson<{
      sessions: Array<{ workSessionId: string; status: string }>;
    }>(monitor.port, "/api/work-sessions?limit=5");
    expect(
      initial.sessions.find((session) => session.workSessionId === workSessionId)?.status,
    ).toBe("ACTIVE");

    await fs.writeFile(monitor.timeFilePath, String(baseTs + 24 * 60 * 60 * 1000 + 60_000), "utf8");
    await sleep(50);

    const filtered = await getJson<{
      sessions: Array<{ workSessionId: string; status: string }>;
    }>(monitor.port, "/api/work-sessions?limit=5&role=conversation.main");
    expect(
      filtered.sessions.find((session) => session.workSessionId === workSessionId)?.status,
    ).toBe("ARCHIVED");

    const unfilteredAfterAdvance = await getJson<{
      sessions: Array<{ workSessionId: string; status: string }>;
    }>(monitor.port, "/api/work-sessions?limit=5");
    expect(
      unfilteredAfterAdvance.sessions.find((session) => session.workSessionId === workSessionId)
        ?.status,
    ).toBe("ARCHIVED");
  });
});

async function startMonitor(params: {
  seedEvents: Array<Record<string, unknown>>;
  fakeNowMs: number;
}): Promise<MonitorHandle> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-task-monitor-home-"));
  const openclawDir = path.join(homeDir, ".openclaw");
  const logsDir = path.join(openclawDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });

  const logPath = path.join(logsDir, "coordination-events.ndjson");
  const seeded = params.seedEvents.map((event) => JSON.stringify(event)).join("\n");
  await fs.writeFile(logPath, seeded ? `${seeded}\n` : "", "utf8");

  const timeFilePath = path.join(homeDir, "fake-now.txt");
  await fs.writeFile(timeFilePath, String(params.fakeNowMs), "utf8");

  const preloadPath = path.join(homeDir, "mock-time.mjs");
  await fs.writeFile(
    preloadPath,
    [
      "import fs from 'node:fs';",
      "const timeFile = process.env.OPENCLAW_TEST_FAKE_TIME_FILE;",
      "if (timeFile) {",
      "  const readNow = () => Number(fs.readFileSync(timeFile, 'utf8').trim());",
      "  Date.now = () => readNow();",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const port = await getFreePort();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      preloadPath,
      "scripts/task-monitor-server.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_TEST_FAKE_TIME_FILE: timeFilePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout?.on("data", (chunk) => {
    stdout.push(String(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk));
  });

  const handle: MonitorHandle = { child, homeDir, logPath, timeFilePath, port, stdout, stderr };
  activeHandles.add(handle);
  await waitForHealth(handle);
  return handle;
}

async function stopMonitor(handle: MonitorHandle): Promise<void> {
  if (handle.child.exitCode === null && !handle.child.killed) {
    handle.child.kill("SIGTERM");
    await waitForExit(handle.child, 5_000).catch(() => {
      handle.child.kill("SIGKILL");
    });
  }
  await fs.rm(handle.homeDir, { recursive: true, force: true });
}

async function waitForHealth(handle: MonitorHandle): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
    if (handle.child.exitCode !== null) {
      throw new Error(
        `task-monitor exited early (${handle.child.exitCode})\nstdout:\n${handle.stdout.join("")}\nstderr:\n${handle.stderr.join("")}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(
    `task-monitor health check timed out\nstdout:\n${handle.stdout.join("")}\nstderr:\n${handle.stderr.join("")}`,
  );
}

async function getJson<T>(port: number, pathname: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  if (!response.ok) {
    throw new Error(`request failed ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("child exit timeout")), timeoutMs);
    }),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
