import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveExecApprovalSessionTarget } from "./exec-approval-session-target.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const baseRequest: ExecApprovalRequest = {
  id: "req-1",
  request: {
    command: "echo hello",
    sessionKey: "agent:main:main",
  },
  createdAtMs: 1000,
  expiresAtMs: 6000,
};

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approval-session-target-"));
  tempDirs.push(dir);
  return dir;
}

function writeStoreFile(
  storePath: string,
  entries: Record<string, Partial<SessionEntry>>,
): OpenClawConfig {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(entries), "utf-8");
  return {
    session: { store: storePath },
  } as OpenClawConfig;
}

function expectResolvedSessionTarget(
  cfg: OpenClawConfig,
  request: ExecApprovalRequest,
): ReturnType<typeof resolveExecApprovalSessionTarget> {
  return resolveExecApprovalSessionTarget({ cfg, request });
}

function buildRequest(
  overrides: Partial<ExecApprovalRequest["request"]> = {},
): ExecApprovalRequest {
  return {
    ...baseRequest,
    request: {
      ...baseRequest.request,
      ...overrides,
    },
  };
}

describe("exec approval session target", () => {
  type PlaceholderStoreCase = {
    name: string;
    relativeStoreDir: string;
    entries: Record<string, Partial<SessionEntry>>;
    request: ExecApprovalRequest;
    expected: ReturnType<typeof resolveExecApprovalSessionTarget>;
  };

  it("returns null for blank session keys, missing entries, and unresolved targets", () => {
    const tmpDir = createTempDir();
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg = writeStoreFile(storePath, {
      "agent:main:main": {
        sessionId: "main",
        updatedAt: 1,
        lastChannel: "slack",
      },
    });

    const requests = [
      buildRequest({ sessionKey: "  " }),
      buildRequest({ sessionKey: "agent:main:missing" }),
      baseRequest,
    ] satisfies ExecApprovalRequest[];

    for (const request of requests) {
      expect(expectResolvedSessionTarget(cfg, request)).toBeNull();
    }
  });

  it("prefers turn-source routing over stale session delivery state", () => {
    const tmpDir = createTempDir();
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg = writeStoreFile(storePath, {
      "agent:main:main": {
        sessionId: "main",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "U1",
      },
    });

    expect(
      resolveExecApprovalSessionTarget({
        cfg,
        request: baseRequest,
        turnSourceChannel: " whatsapp ",
        turnSourceTo: " +15555550123 ",
        turnSourceAccountId: " work ",
        turnSourceThreadId: "1739201675.123",
      }),
    ).toEqual({
      channel: "whatsapp",
      to: "+15555550123",
      accountId: "work",
      threadId: 1739201675,
    });
  });

  it.each([
    {
      name: "uses the parsed session-key agent id for store-path placeholders",
      relativeStoreDir: "helper",
      entries: {
        "agent:helper:main": {
          sessionId: "main",
          updatedAt: 1,
          lastChannel: "discord",
          lastTo: "channel:123",
          lastAccountId: " Work ",
          lastThreadId: "55",
        },
      } as Record<string, Partial<SessionEntry>>,
      request: buildRequest({ sessionKey: "agent:helper:main" }),
      expected: {
        channel: "discord",
        to: "channel:123",
        accountId: "work",
        threadId: 55,
      },
    },
    {
      name: "falls back to request agent id for legacy session keys",
      relativeStoreDir: "worker-1",
      entries: {
        "legacy-main": {
          sessionId: "legacy-main",
          updatedAt: 1,
          lastChannel: "telegram",
          lastTo: "-100123",
          lastThreadId: 77,
        },
      } as Record<string, Partial<SessionEntry>>,
      request: buildRequest({
        agentId: "Worker 1",
        sessionKey: "legacy-main",
      }),
      expected: {
        channel: "telegram",
        to: "-100123",
        accountId: undefined,
        threadId: 77,
      },
    },
  ] satisfies PlaceholderStoreCase[])(
    "$name",
    ({ relativeStoreDir, entries, request, expected }) => {
      const tmpDir = createTempDir();
      const cfg = writeStoreFile(path.join(tmpDir, relativeStoreDir, "sessions.json"), entries);
      cfg.session = { store: path.join(tmpDir, "{agentId}", "sessions.json") };
      expect(expectResolvedSessionTarget(cfg, request)).toEqual(expected);
    },
  );
});
