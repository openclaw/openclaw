import { expect } from "vitest";
import type { SessionAcpMeta } from "../config/sessions/types.js";

/** Asserts the ACP metadata preserved across a Gateway session reset. */
export function expectResetAcpState(acp: SessionAcpMeta | undefined): void {
  expect(acp).toMatchObject({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime:reset",
    identity: { state: "pending", acpxRecordId: "agent:main:main" },
    mode: "persistent",
    runtimeOptions: { runtimeMode: "auto", timeoutSeconds: 30 },
    cwd: "/tmp/acp-session",
    state: "idle",
  });
  expect(acp?.identity?.acpxSessionId).toBeUndefined();
}

/** Builds resolved ACP metadata for reset cleanup fixtures. */
export function resolvedAcpMeta(params: {
  recordId: string;
  backendSessionId: string;
  runtimeSessionName?: string;
  mode?: SessionAcpMeta["mode"];
  runtimeOptions?: SessionAcpMeta["runtimeOptions"];
}): SessionAcpMeta {
  const meta: SessionAcpMeta = {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: params.runtimeSessionName ?? "runtime:reset",
    identity: {
      state: "resolved",
      acpxRecordId: params.recordId,
      acpxSessionId: params.backendSessionId,
      source: "status",
      lastUpdatedAt: Date.now(),
    },
    mode: params.mode ?? "persistent",
    cwd: "/tmp/acp-session",
    state: "idle",
    lastActivityAt: Date.now(),
  };
  if (params.runtimeOptions) {
    meta.runtimeOptions = params.runtimeOptions;
  }
  return meta;
}
