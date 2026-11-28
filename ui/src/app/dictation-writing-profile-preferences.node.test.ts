// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  BASELINE_WRITING_POLICY,
  WRITING_PROFILE_LIMITS,
  WRITING_PROFILES_PREFERENCE_KEY as key,
} from "../../../src/shared/dictation-writing-profiles.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  exportWritingProfilePreferences,
  importWritingProfilePreferences,
  loadWritingProfilePreferences,
  saveWritingProfilePreferences,
} from "./dictation-writing-profile-preferences.ts";

function catalog(revision = "saved") {
  return {
    schemaVersion: 1 as const,
    revision,
    enabled: true,
    defaultProfileId: "mail",
    profiles: [
      {
        id: "mail",
        revision,
        label: "Mail",
        enabled: true,
        priority: 0,
        selectors: [
          {
            kind: "origin" as const,
            app: { kind: "macos-bundle-id" as const, id: "test.browser" },
            origin: "HTTPS://EXAMPLE.TEST:443",
          },
        ],
        policy: BASELINE_WRITING_POLICY,
      },
    ],
  };
}

function transport(entries: Record<string, unknown> = {}, writeStatus = "ok") {
  let generation = 1;
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> =>
    method === "users.prefs.get" ? { status: "ok", entries } : { status: writeStatus },
  );
  const client = {
    request,
    get connectionGeneration() {
      return generation;
    },
  } as unknown as GatewayBrowserClient;
  return {
    client,
    request,
    replace: () => {
      generation++;
    },
  };
}

async function load(client: GatewayBrowserClient) {
  const result = await loadWritingProfilePreferences(client, "owner");
  if (result.status !== "ok") {
    throw new Error(`Unexpected preference status: ${result.status}`);
  }
  return result.current;
}

describe("writing-profile preference adapter", () => {
  it("reads an absent catalog as disabled without persisting a default", async () => {
    const { client, request } = transport();
    const current = await load(client);
    expect(current.raw).toBeNull();
    expect(current.catalog).toEqual({
      schemaVersion: 1,
      revision: "initial",
      enabled: false,
      defaultProfileId: null,
      profiles: [],
    });
    expect(request.mock.calls).toEqual([["users.prefs.get", { keys: [key] }]]);
  });

  it("keeps the exact saved comparator and the unsaved draft on a conflict", async () => {
    const raw = catalog();
    const { client, request } = transport({ [key]: raw }, "conflict");
    const current = await load(client);
    const draft = catalog("edited");
    const before = JSON.stringify(draft);
    expect(current.catalog?.profiles[0]?.selectors[0]).toMatchObject({
      origin: "https://example.test",
    });
    expect(await saveWritingProfilePreferences(client, current, draft)).toEqual({
      status: "conflict",
    });
    expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
      entries: {
        [key]: {
          ...draft,
          profiles: [
            {
              ...draft.profiles[0],
              selectors: [{ ...draft.profiles[0]!.selectors[0], origin: "https://example.test" }],
            },
          ],
        },
      },
      expectedEntries: { [key]: raw },
    });
    expect(JSON.stringify(draft)).toBe(before);
    expect(JSON.parse(exportWritingProfilePreferences(current))).toEqual(raw);
  });

  it("validates the entire import before one CAS write and requires explicit activation", async () => {
    const { client, request } = transport();
    const current = await load(client);
    const imported = catalog("imported");
    for (const text of [
      "{broken",
      JSON.stringify({ ...imported, profiles: [...imported.profiles, { invalid: true }] }),
    ]) {
      expect(await importWritingProfilePreferences(client, current, text)).toMatchObject({
        status: "invalid",
      });
    }
    const future = '{"schemaVersion":2,"privateFuturePolicy":{"enabled":true}}';
    expect(await importWritingProfilePreferences(client, current, future)).toMatchObject({
      status: "invalid",
      futureVersion: 2,
      quarantinedImport: future,
    });
    expect(request).toHaveBeenCalledTimes(1);
    const result = await importWritingProfilePreferences(client, current, JSON.stringify(imported));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.current.catalog?.enabled).toBe(false);
      expect(result.current.catalog?.profiles.map((profile) => profile.enabled)).toEqual([false]);
      expect(result.current.catalog?.revision).not.toBe("imported");
      expect(result.current.catalog?.profiles[0]?.revision).not.toBe("imported");
    }
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      expectedEntries: { [key]: null },
      entries: { [key]: { enabled: false } },
    });
  });

  it("keeps future stored catalogs exportable and refuses every overwrite", async () => {
    const raw = { schemaVersion: 7, policy: { unknown: ["preserve", 42] }, enabled: true };
    const { client, request } = transport({ [key]: raw });
    const current = await load(client);
    expect(current).toMatchObject({
      catalog: null,
      readOnlyReason: "unsupported-version",
      futureVersion: 7,
    });
    expect(JSON.parse(exportWritingProfilePreferences(current))).toEqual(raw);
    expect(await saveWritingProfilePreferences(client, current, catalog("replacement"))).toEqual({
      status: "read-only",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retains deeply nested future JSON without recursive or expanded exports", async () => {
    for (const depth of [1_000, 6_000]) {
      const source = `{"schemaVersion":2,"unknown":${"[".repeat(depth)}"future"${"]".repeat(depth)}}`;
      const raw = JSON.parse(source) as { schemaVersion: number; unknown: unknown };
      const { client, request } = transport({ [key]: raw });
      const current = await load(client);
      expect(current.readOnlyReason).toBe("unsupported-version");
      expect(exportWritingProfilePreferences(current)).toBe(source);
      let retained = (current.raw as typeof raw).unknown;
      let allFrozen = Object.isFrozen(current.raw);
      for (let index = 0; index < depth; index++) {
        allFrozen &&= Object.isFrozen(retained);
        retained = (retained as unknown[])[0];
      }
      expect(allFrozen).toBe(true);
      expect(retained).toBe("future");
      raw.unknown = "changed outside the snapshot";
      expect(exportWritingProfilePreferences(current)).toBe(source);
      expect(await saveWritingProfilePreferences(client, current, catalog())).toEqual({
        status: "read-only",
      });
      expect(request).toHaveBeenCalledTimes(1);
    }
    const oversized = transport({
      [key]: { schemaVersion: 2, unknown: "😀".repeat(WRITING_PROFILE_LIMITS.catalogBytes / 4) },
    });
    expect(await loadWritingProfilePreferences(oversized.client, "owner")).toEqual({
      status: "error",
    });
    expect(oversized.request).toHaveBeenCalledTimes(1);
  });

  it("does not publish a late read or issue a write from a replaced connection", async () => {
    const owner = transport();
    const pending = createDeferred<unknown>();
    owner.request.mockReturnValueOnce(pending.promise);
    const loading = loadWritingProfilePreferences(owner.client, "owner");
    owner.replace();
    pending.resolve({ status: "ok", entries: {} });
    expect(await loading).toEqual({ status: "stale" });
    const current = await load(owner.client);
    owner.replace();
    expect(await saveWritingProfilePreferences(owner.client, current, catalog())).toEqual({
      status: "stale",
    });
    expect(owner.request.mock.calls.every(([method]) => method === "users.prefs.get")).toBe(true);
  });

  it("retires late saves when the existing UI owner changes profile", async () => {
    const { client, request } = transport();
    const current = await load(client);
    const pending = createDeferred<unknown>();
    request.mockReturnValueOnce(pending.promise);
    let currentProfile = true;
    const saving = saveWritingProfilePreferences(client, current, catalog(), {
      isCurrent: () => currentProfile,
    });
    currentProfile = false;
    pending.resolve({ status: "ok" });
    expect(await saving).toEqual({ status: "stale" });
    expect(current.raw).toBeNull();
  });
});
