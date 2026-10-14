/** Shared mocks and issue helpers for the daemon service-audit tests. */
import { vi } from "vitest";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";
import type { resolveBunRuntimeInfo, resolveNodeRuntimeInfo } from "../runtime-paths.js";
import type { SERVICE_AUDIT_CODES, ServiceConfigAudit } from "../service-audit.js";
import type { execSystemctlUser } from "../systemd-exec.js";

export const execSystemctlUserMock: MockFn<typeof execSystemctlUser> = vi.fn();
export const resolveBunRuntimeInfoMock: MockFn<typeof resolveBunRuntimeInfo> = vi.fn();
export const resolveNodeRuntimeInfoMock: MockFn<typeof resolveNodeRuntimeInfo> = vi.fn();

/** Restores the default systemd-unavailable and WAL-safe Bun probe responses. */
export function resetServiceAuditMocks() {
  execSystemctlUserMock.mockReset();
  execSystemctlUserMock.mockResolvedValue({
    stdout: "",
    stderr: "systemd unavailable",
    code: 1,
    termination: "exit",
  });
  resolveBunRuntimeInfoMock.mockReset();
  resolveBunRuntimeInfoMock.mockResolvedValue({
    version: "1.4.0",
    sqliteVersion: "3.51.3",
    sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
    nodeSharedSqlite: false,
    status: "supported",
  });
  resolveNodeRuntimeInfoMock.mockReset();
  resolveNodeRuntimeInfoMock.mockResolvedValue({
    version: "26.8.1",
    sqliteVersion: "3.53.4",
    sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    nodeSharedSqlite: false,
    status: "supported",
  });
}

export function hasIssue(
  audit: ServiceConfigAudit,
  code: (typeof SERVICE_AUDIT_CODES)[keyof typeof SERVICE_AUDIT_CODES],
) {
  return audit.issues.some((issue) => issue.code === code);
}
