/** Shared mocks and issue helpers for the daemon service-audit tests. */
import { vi } from "vitest";
import { runtimeFixture } from "../../cli/update-cli/update-command-fixtures.test-support.js";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";
import type { resolveBunRuntimeInfo, resolveNodeRuntimeInfo } from "../runtime-paths.js";
import type { SERVICE_AUDIT_CODES, ServiceConfigAudit } from "../service-audit.js";
import type { execSystemctl, execSystemctlUser } from "../systemd-exec.js";

export const execSystemctlMock: MockFn<typeof execSystemctl> = vi.fn();
export const execSystemctlUserMock: MockFn<typeof execSystemctlUser> = vi.fn();
export const resolveBunRuntimeInfoMock: MockFn<typeof resolveBunRuntimeInfo> = vi.fn();
export const resolveNodeRuntimeInfoMock: MockFn<typeof resolveNodeRuntimeInfo> = vi.fn();

/** Restores the default systemd-unavailable and WAL-safe Bun probe responses. */
export function resetServiceAuditMocks() {
  for (const mock of [execSystemctlMock, execSystemctlUserMock]) {
    mock.mockReset();
    mock.mockResolvedValue({
      stdout: "",
      stderr: "systemd unavailable",
      code: 1,
      termination: "exit",
    });
  }
  resolveBunRuntimeInfoMock.mockReset();
  resolveBunRuntimeInfoMock.mockResolvedValue(runtimeFixture("1.4.4", "3.51.3"));
  resolveNodeRuntimeInfoMock.mockReset();
  resolveNodeRuntimeInfoMock.mockResolvedValue(runtimeFixture("26.8.1", "3.53.4"));
}

export function hasIssue(
  audit: ServiceConfigAudit,
  code: (typeof SERVICE_AUDIT_CODES)[keyof typeof SERVICE_AUDIT_CODES],
) {
  return audit.issues.some((issue) => issue.code === code);
}
