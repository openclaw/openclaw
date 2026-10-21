import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonlRequestTailer } from "../../scripts/e2e/lib/codex-media-path/jsonl-request-tail.mts";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const mediaScript = (name: string) =>
  path.resolve("scripts/e2e/lib/codex-media-path", `${name}.mjs`);
const jsonl = (value: unknown) => `${JSON.stringify(value)}\n`;

function runWriteConfig(root: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [mediaScript("write-config")], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_TEST_WORKSPACE_DIR: path.join(root, "workspace"),
      PORT: "18790",
      ...env,
    },
  });
}

it.each([
  ["OPENCLAW_CODEX_MEDIA_PATH_TIMEOUT_SECONDS", "1e3"],
  ["PORT", "65536"],
])("rejects invalid write-config %s=%s", (key, value) => {
  const root = tempRoots.make("openclaw-codex-media-path-");
  const result = runWriteConfig(root, { [key]: value });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`invalid ${key}: ${value}`);
});
it("returns a structured error when request logging fails", async () => {
  const requestLogDirectory = tempRoots.make("openclaw-codex-media-path-");
  const child = spawn(process.execPath, [mediaScript("fake-codex-app-server")], {
    env: {
      ...process.env,
      OPENCLAW_CODEX_MEDIA_PATH_APP_SERVER_LOG: requestLogDirectory,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = createBoundedChildOutput();
  const stdout = createBoundedChildOutput();
  const response = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
      const line = stdout
        .text()
        .split("\n")
        .find((entry) => entry.trim());
      if (line) {
        resolve(line);
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`fake app-server exited before response: code=${code} signal=${signal}`)),
    );
  });
  child.stderr.on("data", stderr.append);
  // Reproduce independent pipe delivery: stdout can arrive before stderr.
  child.stderr.pause();
  const closed = once(child, "close");
  try {
    child.stdin.write(jsonl({ id: "request-1", method: "initialize" }));
    const responseLine = await withTimeout(response, 3_000, {
      createError: () =>
        new Error(`timed out waiting for fake app-server response: ${stdout.text()}`),
    });
    expect(JSON.parse(responseLine)).toMatchObject({
      error: {
        message: expect.stringContaining("fake Codex app-server request log write failed"),
      },
      id: "request-1",
    });
    // The reply arrives with stdin open; close then joins both output streams.
    child.stdin.end();
    child.stderr.resume();
    await closed;
    expect(stderr.text()).toContain("fake Codex app-server request log write failed");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await closed;
    }
  }
});

describe("codex media path JSONL tailer", () => {
  function fixture(maxReadBytes = 1024) {
    const logPath = path.join(tempRoots.make("openclaw-codex-media-path-"), "app-server.jsonl");
    const tailer = createJsonlRequestTailer(logPath, { maxReadBytes, historyLimit: 10 });
    return { logPath, tailer };
  }
  const initialize = { method: "initialize" };
  const turn = { method: "turn/start" };
  it("keeps parsed app-server requests and reads only appended lines", () => {
    const { logPath, tailer } = fixture();
    expect(tailer.read()).toEqual([]);
    writeFileSync(logPath, jsonl(initialize));
    expect(tailer.read()).toEqual([initialize]);
    appendFileSync(logPath, JSON.stringify(turn));
    expect(tailer.read()).toEqual([initialize]);
    appendFileSync(logPath, "\n");
    expect(tailer.read()).toEqual([initialize, turn]);
  });

  it("starts from a bounded tail of oversized logs", () => {
    const lastLine = jsonl(turn);
    const { logPath, tailer } = fixture(lastLine.length + 2);
    writeFileSync(logPath, `${"x".repeat(256)}\n${jsonl({ method: "old" })}${lastLine}`);
    expect(tailer.read()).toEqual([turn]);
  });

  it("resets request history when the app-server log is truncated", () => {
    const { logPath, tailer } = fixture();
    const longRequest = { ...initialize, payload: "long enough to rotate" };
    writeFileSync(logPath, jsonl(longRequest));
    expect(tailer.read()).toEqual([longRequest]);
    writeFileSync(logPath, jsonl(turn));
    expect(tailer.read()).toEqual([turn]);
  });
});
