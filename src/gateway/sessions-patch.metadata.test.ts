// Session metadata and policy patches preserve independent fields and reject invalid changes.
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import * as modelSelection from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import { projectCanonicalSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../sessions/agent-harness-session-key.js";
import {
  type ApplySessionsPatchArgs,
  MAIN_SESSION_KEY,
  runPatchFields as runPatch,
  patchFieldsOk as patchOk,
  expectPatchOk,
  expectPatchError,
  mainStoreEntry,
} from "./sessions-patch.test-support.js";

const OPENAI_GPT_ID = "gpt-5.4";

describe("gateway sessions metadata and policy patch", () => {
  beforeAll(async () => {
    await prepareSharedAuthStoreOwnership();
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
  });

  test("keeps a custom SVG icon through store normalization, unrelated patches, and clearing", async () => {
    using defaults = vi.spyOn(modelSelection, "resolveDefaultModelForAgent");
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
    const icon = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const store = mainStoreEntry({ label: "Night watch", color: "purple" });
    const patch = async (fields: { icon?: string | null; label?: string }) =>
      runPatch({ store, ...fields });
    const entry = expectPatchOk(await patch({ icon: svg }));
    expect(entry).toMatchObject({ icon, color: "purple" });
    store[MAIN_SESSION_KEY] = projectCanonicalSessionEntryShape({ ...entry });
    expect(expectPatchOk(await patch({ label: "Updated night watch" }))).toMatchObject({ icon });
    expectPatchError(await patch({ icon: "https://example.com/icon.svg" }), "icon must be");
    expect(store[MAIN_SESSION_KEY].icon).toBe(icon);
    expect(expectPatchOk(await patch({ icon: null })).icon).toBeUndefined();
    expect(store[MAIN_SESSION_KEY].color).toBe("purple");
    expect(defaults).not.toHaveBeenCalled();
  });

  test("keeps manual renames independent of automatic device-label writes and clears", async () => {
    const key = "agent:main:node-1234567890ab";
    const autoLabel = "OpenClaw App · Pixel · 1234567890ab";
    const label = "OpenClaw App · Release planning · 1234567890ab";
    const store: Record<string, SessionEntry> = {};
    const patch = async (fields: { label?: string | null; autoLabel?: string | null }) =>
      await patchOk({ store, storeKey: key, ...fields });

    expect(await patch({ autoLabel })).toMatchObject({ autoLabel });
    await patch({ label });
    // A reconnect can finish after a manual rename; the automatic writer owns a different field.
    expect(await patch({ autoLabel: "Updated device" })).toMatchObject({
      label,
      autoLabel: "Updated device",
    });
    const cleared = await patch({ label: null });
    expect(cleared.label).toBeUndefined();
    expect(cleared.autoLabel).toBe("Updated device");
    expect((await patch({ autoLabel: null })).autoLabel).toBeUndefined();

    // Automatic names do not participate in unique custom-label lookup.
    store.other = { sessionId: "other", updatedAt: 1, label: autoLabel, autoLabel };
    expect(await patch({ autoLabel })).toMatchObject({ autoLabel });
  });

  test.each([false, true])("patches harness sessions only when existing=%s", async (existing) => {
    const key = "agent:main:harness:codex:supervision:session";
    const store: Record<string, SessionEntry> = existing
      ? {
          [key]: {
            sessionId: "harness-session",
            updatedAt: 1,
            agentHarnessId: "codex",
            modelSelectionLocked: true,
          },
        }
      : {};

    const result = await runPatch({ store, storeKey: key, label: "kept" });
    if (!existing) {
      expectPatchError(result, AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
      expect(store[key]).toBeUndefined();
      return;
    }
    const entry = expectPatchOk(result);
    expect(entry.label).toBe("kept");
    expect(store[key]).toMatchObject({
      sessionId: "harness-session",
      label: "kept",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });
  });

  test.each([undefined, { type: "human" as const, id: "profile-ada", label: "Ada" }])(
    "attributes the archive transition and clears attribution on restore: %j",
    async (archivedBy) => {
      const archived = await patchOk({
        mainEntry: { pinnedAt: 10 },
        archived: true,
        expectedSessionId: "sess",
        archivedBy,
      });
      expect(archived.archivedAt).toEqual(expect.any(Number));
      expect(archived.archivedBy).toEqual(archivedBy);
      expect(archived.archiveReason).toBe("manual");
      expect(archived.pinnedAt).toBeUndefined();

      const idempotent = await patchOk({
        mainEntry: {
          archivedAt: archived.archivedAt,
          archivedBy,
          archiveReason: "manual",
        },
        archived: true,
        expectedSessionId: "sess",
        archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      });
      expect(idempotent.archivedAt).toBe(archived.archivedAt);
      expect(idempotent.archivedBy).toEqual(archivedBy);
      expect(idempotent.archiveReason).toBe("manual");

      const restored = await patchOk({
        store: { [MAIN_SESSION_KEY]: idempotent },
        archived: false,
        expectedSessionId: "sess",
      });
      expect([restored.archivedAt, restored.archivedBy, restored.archiveReason]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    },
  );

  const childPinError = "cannot pin a child session; pin its parent session instead";
  test.each<[string, Partial<SessionEntry>, boolean, string?]>([
    [MAIN_SESSION_KEY, {}, false],
    [MAIN_SESSION_KEY, { archivedAt: 10 }, true, "restore it first"],
    [
      "agent:main:dashboard:child",
      { pinnedAt: 10, spawnedBy: MAIN_SESSION_KEY },
      true,
      childPinError,
    ],
    [
      "agent:main:dashboard:child",
      { pinnedAt: 10, parentSessionKey: "agent:main:dashboard:parent" },
      true,
      childPinError,
    ],
    ["agent:main:subagent:child", { pinnedAt: 10 }, true, childPinError],
    ["agent:main:dashboard:root", { spawnedBy: "  ", parentSessionKey: "  " }, true],
    ["agent:main:dashboard:work", { parentSessionKey: MAIN_SESSION_KEY }, true],
  ])("validates pin eligibility on %s with %j", async (key, fields, existing, error) => {
    const result = await runPatch({
      storeKey: key,
      store: existing ? { [key]: { sessionId: "session", updatedAt: 1, ...fields } } : {},
      pinned: true,
    });
    if (error) {
      expectPatchError(result, error);
    } else {
      expect(expectPatchOk(result).pinnedAt).toEqual(expect.any(Number));
    }
  });

  test.each([{ pinned: false }, { label: "Child task" }] as const)(
    "clears stale child pins on a metadata or unpin patch: %j",
    async (patch) => {
      const key = "agent:main:dashboard:child";
      const updated = await patchOk({
        storeKey: key,
        store: {
          [key]: { sessionId: "child", updatedAt: 1, pinnedAt: 10, spawnedBy: MAIN_SESSION_KEY },
        },
        ...patch,
      });
      expect(updated.pinnedAt).toBeUndefined();
    },
  );

  test("preserves existing pins on Home-parented sessions through metadata patches", async () => {
    const key = "agent:main:dashboard:work";
    const updated = await patchOk({
      storeKey: key,
      store: {
        [key]: {
          sessionId: "work",
          updatedAt: 1,
          pinnedAt: 10,
          parentSessionKey: MAIN_SESSION_KEY,
        },
      },
      label: "Work session",
    });
    expect(updated.pinnedAt).toBe(10);
  });

  test("marks archived sessions unread and clears the marker when read", async () => {
    const store = mainStoreEntry({
      archivedAt: 10,
      lastReadAt: 20,
      agentStatus: { note: "Waiting", attention: "hand", expiresAt: Date.now() + 60_000 },
    });
    const unread = await patchOk({ store, unread: true });
    expect(unread.archivedAt).toBe(10);
    expect(unread.lastReadAt).toBe(20);
    expect(unread.markedUnreadAt).toEqual(expect.any(Number));

    const read = await patchOk({ store, unread: false });
    expect(read.archivedAt).toBe(10);
    expect(read.lastReadAt).toEqual(expect.any(Number));
    expect(read.lastReadAt).toBeGreaterThanOrEqual(unread.markedUnreadAt ?? 0);
    expect(read.markedUnreadAt).toBeUndefined();
    expect(read.agentStatus).toBeUndefined();
  });

  test("commits a read acknowledgement without ageing the session row", async () => {
    const store = mainStoreEntry({
      markedUnreadAt: 40,
      agentStatus: { note: "Waiting", attention: "hand", expiresAt: Date.now() + 60_000 },
    });

    const read = await patchOk({ store, unread: false, expectedMarkedUnreadAt: 40 });
    expect(read.updatedAt).toBe(1);
    expect(read.lastReadAt).toEqual(expect.any(Number));
    expect(read.markedUnreadAt).toBeUndefined();
    expect(read.agentStatus).toBeUndefined();

    const marked = await patchOk({ store, unread: true });
    expect(marked.updatedAt).toBeGreaterThan(1);
    expect(marked.markedUnreadAt).toEqual(expect.any(Number));

    const pinned = await patchOk({
      mainEntry: { markedUnreadAt: 40 },
      pinned: true,
      unread: false,
    });
    expect(pinned.pinnedAt).toEqual(expect.any(Number));
    expect(pinned.updatedAt).toBeGreaterThan(1);
  });

  test("commits an icon or color change without ageing the session row", async () => {
    const store = mainStoreEntry({ sessionId: "sess-icon" });

    const iconed = await patchOk({ store, icon: "✅", expectedSessionId: "sess-icon" });
    expect(iconed.icon).toBe("✅");
    expect(iconed.updatedAt).toBe(1);

    const cleared = await patchOk({ store, icon: null, color: null });
    expect(cleared.icon).toBeUndefined();
    expect(cleared.updatedAt).toBe(1);

    const renamed = await patchOk({ store, icon: "🐛", label: "Waiting" });
    expect(renamed.icon).toBe("🐛");
    expect(renamed.updatedAt).toBeGreaterThan(1);
  });

  test("stores sanitized agent status with attention and a bounded TTL", async () => {
    const before = Date.now();
    const entry = await patchOk({
      mainEntry: {},
      statusNote: "  Blocked:\n need the staging password  ",
      attention: "key",
    });
    expect(entry.agentStatus).toMatchObject({
      note: "Blocked: need the staging password",
      attention: "key",
    });
    expect(entry.agentStatus?.expiresAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(entry.agentStatus?.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000);

    expectPatchError(
      await runPatch({ mainEntry: {}, statusNote: "Waiting", ttlMinutes: 121 }),
      "use 1-120",
    );
  });

  test("clears the whole agent status explicitly", async () => {
    const entry = await patchOk({
      mainEntry: {
        agentStatus: { note: "Waiting", attention: "flag", expiresAt: Date.now() + 60_000 },
      },
      attention: null,
    });
    expect(entry.agentStatus).toBeUndefined();
  });

  test.each(["thinkingLevel", "contextWindow", "elevatedLevel"] as const)(
    "clears %s without loading the catalog",
    async (field) => {
      const store = mainStoreEntry({
        ...(field === "elevatedLevel" ? { sessionId: undefined } : {}),
        thinkingLevel: "low",
        contextWindow: "extended",
        elevatedLevel: "off",
      });
      const loadGatewayModelCatalog = vi.fn(async () => {
        throw new Error("Catalog must not be needed for a clear");
      });
      const entry = await patchOk({ store, [field]: null, loadGatewayModelCatalog });
      expect(entry[field]).toBeUndefined();
      expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
    },
  );

  test("recreates partial rows without dropping session settings", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        updatedAt: 1,
        sessionFile: "stale.jsonl",
        label: "Stale Session",
        sendPolicy: "deny",
        modelOverride: OPENAI_GPT_ID,
        liveModelSwitchPending: true,
        responseUsage: "tokens",
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };
    const entry = await patchOk({ store, fastMode: true });

    expect(entry.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(entry.sessionFile).toBeUndefined();
    expect(entry.label).toBeUndefined();
    expect(entry.sendPolicy).toBe("deny");
    expect(entry.modelOverride).toBe(OPENAI_GPT_ID);
    expect(entry.liveModelSwitchPending).toBeUndefined();
    expect(entry.responseUsage).toBe("tokens");
    expect(entry.parentSessionKey).toBe("agent:main:main");
    expect(entry.fastMode).toBe(true);
  });

  test.each([
    { field: "category", raw: "  Research  ", normalized: "Research" },
    { field: "color", raw: "  Blue ", normalized: "blue" },
    { field: "verboseLevel", raw: "  EVERYTHING  ", normalized: "full" },
    { field: "traceLevel", raw: "  UNFILTERED  ", normalized: "raw" },
  ] as const)("normalizes and clears $field", async ({ field, raw, normalized }) => {
    const entry = await patchOk({ mainEntry: {}, [field]: raw });
    expect(entry[field]).toBe(normalized);

    const cleared = await patchOk({ mainEntry: { [field]: normalized }, [field]: null });
    expect(cleared[field]).toBeUndefined();
  });

  test.each(["ultrafast"] as const)("sets fastMode to %s", async (fastMode) => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {} as SessionEntry,
    };
    const entry = await patchOk({ store, fastMode });

    expect(entry.fastMode).toBe(fastMode);
  });

  test("sets, replaces, clears, and normalizes tool overrides", async () => {
    const store = mainStoreEntry({});
    const set = await patchOk({
      store,
      toolOverrides: {
        mcpServers: { zeta: false, alpha: true },
        mcpToolsDeny: { zeta: [], alpha: ["write", "read", "write"] },
        skills: {},
        webSearch: true,
      },
    });
    expect(set.toolOverrides).toEqual({
      mcpServers: { alpha: true, zeta: false },
      mcpToolsDeny: { alpha: ["read", "write"] },
      webSearch: true,
    });

    const replaced = await patchOk({ store, toolOverrides: { skills: { release: false } } });
    expect(replaced.toolOverrides).toEqual({ skills: { release: false } });

    const normalizedEmpty = await patchOk({ store, toolOverrides: { mcpToolsDeny: { docs: [] } } });
    expect(normalizedEmpty.toolOverrides).toBeUndefined();

    store[MAIN_SESSION_KEY] = {
      ...normalizedEmpty,
      toolOverrides: { webSearch: false },
    };
    const cleared = await patchOk({ store, toolOverrides: null });
    expect(cleared.toolOverrides).toBeUndefined();
  });

  test.each([
    { patch: { verboseLevel: "maybe" }, error: 'invalid verboseLevel (use "on"|"off"|"full")' },
    { patch: { traceLevel: "maybe" }, error: 'invalid traceLevel (use "on"|"off"|"raw")' },
    {
      patch: { verboseLevel: "maybe", traceLevel: "maybe" },
      error: 'invalid verboseLevel (use "on"|"off"|"full")',
    },
    { patch: { elevatedLevel: "maybe" }, error: "invalid elevatedLevel" },
    {
      patch: { color: "crimson" },
      error: "color must be one of: red, blue, green, yellow, purple, orange, pink, cyan",
    },
    { patch: { inheritedToolDeny: ["exec"] }, error: "inheritedToolDeny is only supported" },
    {
      patch: { inheritedToolPolicyVersion: 1 },
      error: "inheritedToolPolicyVersion is only supported",
    },
    { patch: { inheritedToolAllow: ["read"] }, error: "inheritedToolAllow is only supported" },
    { patch: { execHost: "edge" }, error: "invalid execHost" },
    { patch: { sendPolicy: "ask" as unknown as "allow" }, error: "invalid sendPolicy" },
    {
      patch: { groupActivation: "never" as unknown as "mention" },
      error: "invalid groupActivation",
    },
  ] satisfies { patch: Omit<ApplySessionsPatchArgs["patch"], "key">; error: string }[])(
    "rejects $patch: $error",
    async ({ patch, error }) => {
      const result = await runPatch({ ...patch });
      expectPatchError(result, error);
    },
  );

  test.each([
    {
      field: "completionOwnerSessionKey",
      value: "agent:main:main",
      replacement: "agent:main:discord:direct:bob",
      error: "completionOwnerSessionKey cannot be changed once set",
    },
    {
      field: "inheritedToolPolicyVersion",
      value: 1,
      replacement: null,
      error: "inheritedToolPolicyVersion cannot be cleared once set",
    },
  ] as const)(
    "sets immutable $field for ACP sessions",
    async ({ field, value, replacement, error }) => {
      const entry = await patchOk({ storeKey: "agent:main:acp:child", [field]: value });
      expect(entry[field]).toBe(value);

      const result = await runPatch({
        storeKey: "agent:main:acp:child",
        store: { "agent:main:acp:child": entry },
        [field]: replacement,
      });
      expectPatchError(result, error);
    },
  );

  test.each([
    { field: "inheritedToolDeny", input: ["bash", "read", "bash"], expected: ["exec", "read"] },
    {
      field: "inheritedToolAllow",
      input: ["sessions_spawn", "read", "sessions_spawn"],
      expected: ["sessions_spawn", "read"],
    },
  ] as const)("normalizes $field for ACP sessions", async ({ field, input, expected }) => {
    const entry = await patchOk({ storeKey: "agent:main:acp:child", [field]: [...input] });
    expect(entry[field]).toEqual(expected);
  });

  test("preserves inheritedToolDeny entries beyond large configured lists", async () => {
    const configuredDeny = Array.from({ length: 150 }, (_, index) => `custom_${index}`);
    const entry = await patchOk({
      storeKey: "agent:main:subagent:child",
      inheritedToolDeny: [...configuredDeny, "exec"],
    });
    expect(entry.inheritedToolDeny).toHaveLength(151);
    expect(entry.inheritedToolDeny?.at(-1)).toBe("exec");
  });

  test("normalizes exec/send/group patches", async () => {
    const entry = await patchOk({
      execHost: " AUTO ",
      execNode: " worker-1 ",
      sendPolicy: "DENY" as unknown as "allow",
      groupActivation: "Always" as unknown as "mention",
    });
    expect(entry.execHost).toBe("auto");
    expect(entry.execNode).toBe("worker-1");
    expect(entry.sendPolicy).toBe("deny");
    expect(entry.groupActivation).toBe("always");
  });

  test("stores and clears the session permission mode", async () => {
    const stored = await patchOk({
      mainEntry: { sessionRoot: "/workspace/project" },
      permissionMode: "workspace",
    });
    expect(stored.permissionMode).toBe("workspace");
    expect(stored.sessionRoot).toBe("/workspace/project");

    const cleared = await patchOk({ store: { [MAIN_SESSION_KEY]: stored }, permissionMode: null });
    expect(cleared.permissionMode).toBeUndefined();
    expect(cleared.sessionRoot).toBe("/workspace/project");
  });

  test.each([{ execSecurity: null }, { execAsk: "always" }])(
    "rejects retired session policy patch %j without writing",
    async (retiredPatch) => {
      for (const store of [
        {},
        mainStoreEntry({ label: "Original", permissionMode: "read-only" }),
      ]) {
        const before = structuredClone(store);
        const result = await runPatch({
          store,
          label: "Changed",
          permissionMode: "guarded",
          ...retiredPatch,
        });

        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message:
              "execSecurity/execAsk are retired; set permissionMode (read-only|guarded|workspace|full) instead, or use /exec for this run only.",
          },
        });
        expect(store).toEqual(before);
      }
    },
  );

  test.each([
    { host: "node", node: "worker-2", expectedHost: "node", expectedNode: "worker-2" },
    { host: "node", node: null, expectedHost: undefined, expectedNode: undefined },
    { host: "gateway", node: null, expectedHost: "gateway", expectedNode: undefined },
  ] as const)(
    "clears node cwd when $host binding changes to $node",
    async ({ host, node, expectedHost, expectedNode }) => {
      const store = mainStoreEntry({
        execHost: host,
        execNode: "worker-1",
        execCwd: "/workspace/on-worker-1",
      });
      const changed = await patchOk({ store, execNode: node });
      expect(changed.execNode).toBe(expectedNode);
      expect(changed.execCwd).toBeUndefined();
      expect(changed.execHost).toBe(expectedHost);
    },
  );
});
