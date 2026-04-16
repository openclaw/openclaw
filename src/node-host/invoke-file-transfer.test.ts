import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { ExecApprovalsSnapshot } from "../infra/exec-approvals.js";
import type { SkillBinsProvider } from "./invoke-types.js";
import { handleInvoke, type NodeInvokeRequestPayload } from "./invoke.js";

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  return {
    ...orig,
    readExecApprovalsSnapshot: vi.fn(),
    ensureExecApprovals: vi.fn(),
  };
});

vi.mock("./plugin-node-host.js", () => ({
  invokeRegisteredNodeHostCommand: vi.fn().mockResolvedValue(null),
}));

import { readExecApprovalsSnapshot } from "../infra/exec-approvals.js";

const mockedReadExecApprovalsSnapshot = vi.mocked(readExecApprovalsSnapshot);

function makeFrame(command: string, params?: Record<string, unknown>): NodeInvokeRequestPayload {
  return {
    id: "test-id",
    nodeId: "test-node",
    command,
    paramsJSON: params ? JSON.stringify(params) : null,
  };
}

function makeClient(): {
  client: GatewayClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
    }),
  } as unknown as GatewayClient;
  return { client, calls };
}

const stubSkillBins: SkillBinsProvider = { current: async () => [] };

function getResultPayload(calls: Array<{ method: string; params: unknown }>): {
  ok: boolean;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
} {
  const call = calls.find((c) => c.method === "node.invoke.result");
  return (call?.params ?? {}) as {
    ok: boolean;
    payloadJSON?: string;
    error?: { code?: string; message?: string };
  };
}

function mockAllowlistSnapshot(opts?: {
  security?: string;
  allowlist?: Array<{ pattern: string }>;
}): void {
  mockedReadExecApprovalsSnapshot.mockReturnValue({
    path: "/tmp/exec-approvals.json",
    exists: true,
    raw: "{}",
    hash: "abc",
    file: {
      version: 1,
      defaults: { security: opts?.security ?? "allowlist" } as never,
      agents: opts?.allowlist ? { "*": { allowlist: opts.allowlist } } : undefined,
    },
  } as ExecApprovalsSnapshot);
}

describe("file.read", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-file-read-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a utf8 text file successfully", async () => {
    const filePath = path.join(tmpDir, "hello.txt");
    fs.writeFileSync(filePath, "hello world");
    const { client, calls } = makeClient();

    await handleInvoke(
      makeFrame("file.read", { path: filePath, encoding: "utf8" }),
      client,
      stubSkillBins,
    );

    const result = getResultPayload(calls);
    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.payloadJSON!);
    expect(payload.data).toBe("hello world");
    expect(payload.encoding).toBe("utf8");
    expect(payload.size).toBe(11);
    expect(payload.mimeType).toBe("text/plain");
  });

  it("reads a binary file as base64 successfully", async () => {
    const filePath = path.join(tmpDir, "test.png");
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(filePath, buf);
    const { client, calls } = makeClient();

    await handleInvoke(makeFrame("file.read", { path: filePath }), client, stubSkillBins);

    const result = getResultPayload(calls);
    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.payloadJSON!);
    expect(payload.encoding).toBe("base64");
    expect(Buffer.from(payload.data, "base64")).toEqual(buf);
    expect(payload.size).toBe(8);
    expect(payload.mimeType).toBe("image/png");
  });

  it("returns NOT_FOUND for missing file", async () => {
    const { client, calls } = makeClient();

    await handleInvoke(
      makeFrame("file.read", { path: path.join(tmpDir, "nope.txt") }),
      client,
      stubSkillBins,
    );

    const result = getResultPayload(calls);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  it("returns FILE_TOO_LARGE when file exceeds 64MB", async () => {
    const filePath = path.join(tmpDir, "big.bin");
    // Create a sparse file that reports > 64MB via stat
    const fd = fs.openSync(filePath, "w");
    fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    const { client, calls } = makeClient();

    await handleInvoke(makeFrame("file.read", { path: filePath }), client, stubSkillBins);

    const result = getResultPayload(calls);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("FILE_TOO_LARGE");
  });

  it("returns INVALID_REQUEST when path is missing", async () => {
    const { client, calls } = makeClient();

    await handleInvoke(makeFrame("file.read", {}), client, stubSkillBins);

    const result = getResultPayload(calls);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_REQUEST");
  });
});

describe("file.write", () => {
  let tmpDir: string;
  let previousOpenClawHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-file-write-"));
    previousOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = tmpDir;
  });

  afterEach(() => {
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a file when file.write is in the allowlist", async () => {
    mockAllowlistSnapshot({ allowlist: [{ pattern: "file.write" }] });
    const filePath = path.join(tmpDir, "out.txt");
    const { client, calls } = makeClient();

    await handleInvoke(
      makeFrame("file.write", { path: filePath, data: "hello", encoding: "utf8" }),
      client,
      stubSkillBins,
    );

    const result = getResultPayload(calls);
    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.payloadJSON!);
    expect(payload.path).toBe(filePath);
    expect(payload.size).toBe(5);
    expect(fs.readFileSync(filePath, "utf8")).toBe("hello");
  });

  it("returns PERMISSION_DENIED when file.write is not in the allowlist", async () => {
    mockAllowlistSnapshot({ allowlist: [] });
    const { client, calls } = makeClient();

    await handleInvoke(
      makeFrame("file.write", {
        path: path.join(tmpDir, "out.txt"),
        data: "hello",
        encoding: "utf8",
      }),
      client,
      stubSkillBins,
    );

    const result = getResultPayload(calls);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
  });

  it("allows file.write when security is full", async () => {
    mockAllowlistSnapshot({ security: "full" });
    const filePath = path.join(tmpDir, "full.txt");
    const { client, calls } = makeClient();

    await handleInvoke(
      makeFrame("file.write", { path: filePath, data: "ok", encoding: "utf8" }),
      client,
      stubSkillBins,
    );

    const result = getResultPayload(calls);
    expect(result.ok).toBe(true);
  });

  it("returns INVALID_REQUEST when data is missing", async () => {
    mockAllowlistSnapshot({ security: "full" });
    const { client, calls } = makeClient();

    await handleInvoke(
      makeFrame("file.write", { path: path.join(tmpDir, "out.txt") }),
      client,
      stubSkillBins,
    );

    const result = getResultPayload(calls);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_REQUEST");
  });

  it("returns FILE_TOO_LARGE when data exceeds 64MB", async () => {
    mockAllowlistSnapshot({ security: "full" });
    // Create a base64 string that decodes to > 64MB
    const bigData = Buffer.alloc(64 * 1024 * 1024 + 1, 0x41).toString("base64");
    const { client, calls } = makeClient();

    await handleInvoke(
      makeFrame("file.write", {
        path: path.join(tmpDir, "big.bin"),
        data: bigData,
        encoding: "base64",
      }),
      client,
      stubSkillBins,
    );

    const result = getResultPayload(calls);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("FILE_TOO_LARGE");
  });
});
