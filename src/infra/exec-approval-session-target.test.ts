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

describe("exec approval session target", () => {
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

    const cases = [
      {
        request: {
          ...baseRequest,
          request: {
            ...baseRequest.request,
            sessionKey: "  ",
          },
        },
      },
      {
        request: {
          ...baseRequest,
          request: {
            ...baseRequest.request,
            sessionKey: "agent:main:missing",
          },
        },
      },
      {
        request: baseRequest,
      },
    ];

    for (const testCase of cases) {
      expect(
        resolveExecApprovalSessionTarget({
          cfg,
          request: testCase.request,
        }),
      ).toBeNull();
    }
  });

  it("prefers turn-source routing over stale session delivery state", () => {
    const tmpDir = createTempDir();
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg = writeStoreFile(storePath, {
      "agent:main:main": {
        sessionId: "main",
        updatedAt: 1,
        channel: "slack",
        to: "U1",
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

  it("uses the parsed session-key agent id for store-path placeholders", () => {
    const tmpDir = createTempDir();
    const storePath = path.join(tmpDir, "{agentId}", "sessions.json");
    const cfg = writeStoreFile(path.join(tmpDir, "helper", "sessions.json"), {
      "agent:helper:main": {
        sessionId: "main",
        updatedAt: 1,
        lastChannel: "discord",
        lastTo: "channel:123",
        lastAccountId: " Work ",
        lastThreadId: "55",
      },
    });
    cfg.session = { store: storePath };

    expect(
      resolveExecApprovalSessionTarget({
        cfg,
        request: {
          ...baseRequest,
          request: {
            ...baseRequest.request,
            sessionKey: "agent:helper:main",
          },
        },
      }),
    ).toEqual({
      channel: "discord",
      to: "channel:123",
      accountId: "work",
      threadId: 55,
    });
  });

  it("falls back to request agent id for legacy session keys", () => {
    const tmpDir = createTempDir();
    const storePath = path.join(tmpDir, "{agentId}", "sessions.json");
    const cfg = writeStoreFile(path.join(tmpDir, "worker-1", "sessions.json"), {
      "legacy-main": {
        sessionId: "legacy-main",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-100123",
        lastThreadId: 77,
      },
    });
    cfg.session = { store: storePath };

    expect(
      resolveExecApprovalSessionTarget({
        cfg,
        request: {
          ...baseRequest,
          request: {
            ...baseRequest.request,
            agentId: "Worker 1",
            sessionKey: "legacy-main",
          },
        },
      }),
    ).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: undefined,
      threadId: 77,
    });
  });
});
