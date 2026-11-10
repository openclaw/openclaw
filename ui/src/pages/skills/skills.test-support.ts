import type { SkillLibraryEntry, SkillsLibraryListResult } from "@openclaw/gateway-protocol";
import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";

export function requestFor(handlers: Record<string, (params?: unknown) => unknown> = {}) {
  return vi.fn(async (method: string, params?: unknown) => {
    if (!Object.hasOwn(handlers, method)) {
      throw new Error(`Unexpected method: ${method}`);
    }
    return handlers[method]!(params);
  });
}

export function libraryList(canManageWorkspace = true): SkillsLibraryListResult {
  return {
    entries: [],
    profileId: "alice",
    multipleProfiles: true,
    defaultTarget: "personal",
    canManageWorkspace,
    defaultSelectionLimit: 64,
  };
}

export function connectedGateway(
  request: (method: string, params?: unknown) => Promise<unknown>,
  methods: string[],
) {
  return createApplicationGateway(
    createApplicationGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      phase: "connected",
      hello: gatewayHelloForMethods(methods),
      assistantAgentId: "main",
      sessionKey: "main",
    }),
  );
}

export function libraryEntry(overrides: Partial<SkillLibraryEntry> = {}): SkillLibraryEntry {
  return {
    skillId: "12345678-1234-1234-1234-123456789abc",
    revision: "a".repeat(64),
    slug: "existing-skill",
    name: "existing-skill",
    description: "An existing skill with an image",
    ownerProfileId: "alice",
    authorProfileId: "alice",
    ownerLabel: "Alice",
    shared: false,
    enabled: true,
    removed: false,
    canEdit: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
