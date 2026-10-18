import type { RouteLocation } from "@openclaw/uirouter";
import { vi } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import type { BootRecord } from "./boot-record.ts";
import type { ApplicationContext } from "./context.ts";

export function makeRoutingGateway(snapshot: object = {}) {
  type Gateway = ApplicationContext["gateway"];
  const listeners = new Set<Parameters<Gateway["subscribe"]>[0]>();
  const gateway = {
    snapshot: { phase: "connected", client: {}, hello: null, ...snapshot },
    subscribe: vi.fn((listener: Parameters<Gateway["subscribe"]>[0]) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as Gateway;
  return {
    gateway,
    publish(update: object) {
      Object.assign(gateway.snapshot, update);
      listeners.forEach((listener) => listener(gateway.snapshot));
    },
  };
}

export function makeLocation(pathname = "/", search = "", hash = ""): RouteLocation {
  return { pathname, search, hash };
}

export function makeBootRoster(overrides: Partial<AgentsListResult> = {}): AgentsListResult {
  return {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main" }],
    ...overrides,
  };
}

export function makeBootRecord(scope: string, overrides: Partial<BootRecord> = {}): BootRecord {
  return {
    version: 2,
    authMethod: "token",
    credential: "9d17676d",
    scope,
    savedAt: Date.now(),
    profileId: "profile-a",
    agents: makeBootRoster(),
    groups: [],
    sectionOrder: [],
    ...overrides,
  };
}
