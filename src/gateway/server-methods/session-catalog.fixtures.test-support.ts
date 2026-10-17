import { expect } from "vitest";
import type {
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.js";

export function catalogSession(
  threadId: string,
  overrides: Partial<SessionCatalogSession> = {},
): SessionCatalogSession {
  return {
    threadId,
    status: "stored",
    archived: false,
    canContinue: true,
    canArchive: false,
    ...overrides,
  };
}

export function catalogHost(overrides: Partial<SessionCatalogHost> = {}): SessionCatalogHost {
  return {
    hostId: "gateway:local",
    label: "Local",
    kind: "gateway",
    connected: true,
    sessions: [],
    ...overrides,
  };
}

export function expectCatalogs(respond: unknown, catalogs: unknown[]) {
  expect(respond).toHaveBeenCalledWith(true, { catalogs });
}

export function expectCatalog(respond: unknown, catalog: Record<string, unknown>) {
  expectCatalogs(respond, [expect.objectContaining(catalog)]);
}
