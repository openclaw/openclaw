import { vi } from "vitest";
import type * as SessionWriteLockModule from "../agents/session-write-lock.js";

type SessionWriteLockModuleShape = typeof SessionWriteLockModule;

export async function buildSessionWriteLockModuleMock(
  loadActual: () => Promise<SessionWriteLockModuleShape>,
  acquireSessionWriteLock: SessionWriteLockModuleShape["acquireSessionWriteLock"],
): Promise<SessionWriteLockModuleShape> {
  const original = await loadActual();
  return {
    ...original,
    acquireSessionWriteLock,
  };
}

export function resetModulesWithSessionWriteLockDoMock(
  modulePath: string,
  acquireSessionWriteLock: SessionWriteLockModuleShape["acquireSessionWriteLock"],
): void {
  vi.resetModules();
  vi.doMock(modulePath, () =>
    buildSessionWriteLockModuleMock(
      () => vi.importActual<SessionWriteLockModuleShape>(modulePath),
      acquireSessionWriteLock,
    ),
  );
}
