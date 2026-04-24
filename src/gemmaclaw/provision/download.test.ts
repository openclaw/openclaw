import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { downloadFile, execCommand, fileExists, waitForHealthy } from "./download.js";

const TEST_DIR = path.join(import.meta.dirname, ".test-download-tmp");

beforeAll(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  // Clean up test files after each test.
  const entries = await fs.readdir(TEST_DIR).catch(() => []);
  for (const entry of entries) {
    await fs.unlink(path.join(TEST_DIR, entry)).catch(() => {});
  }
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe("downloadFile", () => {
  let server: http.Server;
  let port: number;
  const testContent = "Hello, Gemmaclaw!";
  const testSha256 = createHash("sha256").update(testContent).digest("hex");

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/test-file") {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(Buffer.byteLength(testContent)),
        });
        res.end(testContent);
        return;
      }
      if (req.url === "/404") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("downloads a file and returns sha256", async () => {
    const dest = path.join(TEST_DIR, "downloaded.txt");
    const result = await downloadFile(`http://127.0.0.1:${port}/test-file`, dest);

    expect(result.sha256).toBe(testSha256);
    expect(result.bytesWritten).toBe(Buffer.byteLength(testContent));

    const content = await fs.readFile(dest, "utf-8");
    expect(content).toBe(testContent);
  });

  it("verifies sha256 and succeeds on match", async () => {
    const dest = path.join(TEST_DIR, "verified.txt");
    const result = await downloadFile(`http://127.0.0.1:${port}/test-file`, dest, {
      expectedSha256: testSha256,
    });
    expect(result.sha256).toBe(testSha256);
  });

  it("verifies sha256 and fails on mismatch", async () => {
    const dest = path.join(TEST_DIR, "bad-hash.txt");
    await expect(
      downloadFile(`http://127.0.0.1:${port}/test-file`, dest, {
        expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toThrow(/SHA256 mismatch/);

    // File should be cleaned up on mismatch.
    expect(await fileExists(dest)).toBe(false);
  });

  it("throws on HTTP error", async () => {
    const dest = path.join(TEST_DIR, "error.txt");
    await expect(downloadFile(`http://127.0.0.1:${port}/404`, dest)).rejects.toThrow(/HTTP 404/);
  });

  it("reports progress", async () => {
    const dest = path.join(TEST_DIR, "progress.txt");
    const reports: Array<{ bytes: number; total: number | null }> = [];

    await downloadFile(`http://127.0.0.1:${port}/test-file`, dest, {
      onProgress: (bytes, total) => {
        reports.push({ bytes, total });
      },
    });

    expect(reports.length).toBeGreaterThan(0);
    const last = reports[reports.length - 1];
    expect(last.bytes).toBe(Buffer.byteLength(testContent));
  });
});

describe("execCommand", () => {
  it("runs a command and captures output", async () => {
    const result = await execCommand("echo", ["hello"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("captures stderr", async () => {
    const result = await execCommand("bash", ["-c", "echo error >&2"]);
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe("error");
  });

  it("returns non-zero exit code", async () => {
    const result = await execCommand("bash", ["-c", "exit 42"]);
    expect(result.code).toBe(42);
  });

  it("passes stdin", async () => {
    const result = await execCommand("cat", [], { stdin: "piped input" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("piped input");
  });
});

describe("waitForHealthy", () => {
  it("returns true when server responds 200", async () => {
    const server = http.createServer((_, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const result = await waitForHealthy(`http://127.0.0.1:${port}`, {
        timeoutMs: 3000,
      });
      expect(result).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("returns false when no server is listening", async () => {
    const result = await waitForHealthy("http://127.0.0.1:19999", {
      timeoutMs: 1000,
      intervalMs: 200,
    });
    expect(result).toBe(false);
  });
});

describe("fileExists", () => {
  it("returns true for existing file", async () => {
    const filePath = path.join(TEST_DIR, "exists.txt");
    await fs.writeFile(filePath, "test");
    expect(await fileExists(filePath)).toBe(true);
  });

  it("returns false for non-existing file", async () => {
    expect(await fileExists(path.join(TEST_DIR, "nope.txt"))).toBe(false);
  });
});
