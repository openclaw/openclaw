import { vi } from "vitest";
import type * as SessionWriteLockModule from "../agents/session-write-lock.js";

type SessionWriteLockModuleShape = typeof SessionWriteLockModule;

export async function buildSessionWriteLockModuleMock(
  importOriginal: () => Promise<SessionWriteLockModuleShape>,
  acquireSessionWriteLock: SessionWriteLockModuleShape["acquireSessionWriteLock"],
): Promise<SessionWriteLockModuleShape> {
  const original = await importOriginal();
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
  vi.doMock(modulePath, (importOriginal) =>
    buildSessionWriteLockModuleMock(
      importOriginal as () => Promise<SessionWriteLockModuleShape>,
      acquireSessionWriteLock,
    ),
  );
}
