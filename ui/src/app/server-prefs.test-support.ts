import { vi } from "vitest";
import type { UsersPrefsSetParams } from "../../../packages/gateway-protocol/src/schema/users.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { RuntimeConfigExternalMutationOptions } from "../lib/config/config-gateway-operations.ts";
import { applyServerUiPrefs, refreshProfileAppearancePrefs } from "./server-prefs-reconcile.ts";
import { pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { patchSettings } from "./settings.ts";

export type RequestMock = ReturnType<
  typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>
>;

export function configWithPrefs(prefs: Record<string, unknown>) {
  return { ui: { prefs } };
}

export function createServerPrefsWriter(
  request: RequestMock,
  gatewayUrl = "ws://gw",
  connected = true,
  refresh: { ok: true } | { ok: false; error: string } = { ok: true },
  canPatch = true,
): Parameters<typeof pushServerUiPrefs>[0] {
  const client = { request, gatewayUrl, connected } as unknown as GatewayBrowserClient;
  const writer = {
    canPatch,
    state: { client, connected },
    runExternalMutation: async <T>(
      task: (client: GatewayBrowserClient) => Promise<T>,
      options?: RuntimeConfigExternalMutationOptions<T>,
    ) => {
      if (!writer.state.connected) {
        return {
          ok: false as const,
          reason: "unavailable" as const,
          error: "offline",
        };
      }
      if (options?.canDispatch && !options.canDispatch()) {
        return {
          ok: false as const,
          reason: "unavailable" as const,
          error: options.dispatchError ?? "dispatch blocked",
        };
      }
      try {
        return {
          ok: true as const,
          value: await task(client),
          refresh,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          reason: message.includes("config changed since last load")
            ? ("conflict" as const)
            : error instanceof GatewayRequestError &&
                (error.gatewayCode === "INVALID_REQUEST" || error.gatewayCode === "FORBIDDEN")
              ? ("rejected" as const)
              : ("error" as const),
          error: message,
        };
      }
    },
  };
  return writer;
}

export function createProfilePrefsServer(
  initial: Record<string, Record<string, unknown>> = {},
  scope = "ws://navigation",
  config: unknown = {
    ui: { prefs: { sidebarEntries: ["route:usage", "plugin:workboard/workboard"] } },
  },
) {
  const profiles = structuredClone(initial);
  const connect = (profileId: string) => {
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async (method, params) => {
        const entries = (profiles[profileId] ??= {});
        if (method === "users.prefs.get") {
          return { status: "ok", entries: structuredClone(entries) };
        }
        if (method !== "users.prefs.set") {
          throw new Error("unexpected global mutation: " + method);
        }
        const update = params as UsersPrefsSetParams;
        for (const [key, expected] of Object.entries(update.expectedEntries ?? {})) {
          if (JSON.stringify(entries[key] ?? null) !== JSON.stringify(expected)) {
            return { status: "conflict" };
          }
        }
        Object.assign(entries, structuredClone(update.entries));
        return { status: "ok" };
      },
    );
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const refresh = () =>
      refreshProfileAppearancePrefs({
        client: writer.state.client!,
        profileId,
        configObject: config,
        scope,
        onApplied: vi.fn(),
      });
    return { writer, request, refresh };
  };
  return { profiles, connect };
}

export function refreshServerPrefsProfile(
  writer: ReturnType<typeof createServerPrefsWriter>,
  profileId: string,
  configObject: unknown = {},
) {
  const client = writer.state.client!;
  return refreshProfileAppearancePrefs({
    client,
    profileId,
    scope: client.gatewayUrl,
    configObject,
    onApplied: vi.fn(),
  });
}

export async function initializeServerPrefsProfile(
  scope: string,
  profileId: string,
  configObject: unknown = {},
) {
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
  applyServerUiPrefs(configObject, { scope, profileId, onApplied: vi.fn() });
  const initial = createServerPrefsWriter(
    vi.fn(async () => ({ status: "ok", entries: {} })),
    scope,
  );
  await refreshServerPrefsProfile(initial, profileId);
}
