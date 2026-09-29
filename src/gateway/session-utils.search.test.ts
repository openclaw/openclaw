import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import * as display from "./session-utils-display.js";
import {
  filterAndSortSessionEntries,
  listProjectedSessions,
  prepareSessionRowSelection,
} from "./session-utils-list.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

const baseCfg = {
  session: { mainKey: "main" },
  agents: { list: [{ id: "main", default: true }] },
} as OpenClawConfig;

function selectSessionKeys(params: {
  opts: Parameters<typeof filterAndSortSessionEntries>[0]["opts"];
  cfg?: OpenClawConfig;
  store: Record<string, SessionEntry>;
  now?: number;
}): string[] {
  const now = params.now ?? Date.now();
  const store = params.store;
  const projection = createSessionRowProjectionFixture({
    cfg: params.cfg ?? baseCfg,
    store,
    agentId: "main",
  });
  try {
    return filterAndSortSessionEntries({
      ...prepareSessionRowSelection(projection, params.opts),
      now,
    }).map(([key]) => key);
  } finally {
    projection.dispose();
  }
}

describe("filterAndSortSessionEntries search", () => {
  test("prepares workspace identity names before selection and refreshes them after edits", async () => {
    const workspace = tempDirs.make("openclaw-search-identity-");
    const identityPath = path.join(workspace, "IDENTITY.md");
    await fs.writeFile(identityPath, "- Name: Astronomy\n");
    const cfg: OpenClawConfig = { agents: { entries: { main: { workspace } } } };
    const key = "agent:main:session";
    const projection = createSessionRowProjectionFixture({
      cfg,
      store: { [key]: { sessionId: "workspace-identity", updatedAt: 1 } },
    });
    const search = async (value: string) =>
      (await listProjectedSessions({ projection, opts: { search: value } })).sessions.map(
        (row) => row.key,
      );
    try {
      expect(await search("Astronomy")).toEqual([key]);
      await fs.writeFile(`${identityPath}.next`, "- Name: Chemistry\n");
      await fs.rename(`${identityPath}.next`, identityPath);
      expect(await search("Astronomy")).toEqual([]);
      expect(await search("Chemistry")).toEqual([key]);
    } finally {
      projection.dispose();
    }
  });

  test("reuses static search facts until the resident entry is replaced", () => {
    const key = "agent:main:search-revision";
    const entry = { sessionId: "search-revision", updatedAt: 1, label: "First Title" };
    const projection = createSessionRowProjectionFixture({ cfg: baseCfg, store: { [key]: entry } });
    const displayName = vi.spyOn(display, "resolveGatewaySessionDisplayName");
    const search = (query: string) =>
      filterAndSortSessionEntries(prepareSessionRowSelection(projection, { search: query })).map(
        ([selected]) => selected,
      );
    try {
      expect(search("FIRST")).toEqual([key]);
      displayName.mockClear();
      expect(search("TITLE")).toEqual([key]);
      expect(displayName).not.toHaveBeenCalled();
      projection.setEntry(key, { ...entry, label: "Second Name" });
      expect(search("FIRST")).toEqual([]);
      expect(search("SECOND")).toEqual([key]);
      displayName.mockClear();
      expect(search("NAME")).toEqual([key]);
      expect(displayName).not.toHaveBeenCalled();
    } finally {
      displayName.mockRestore();
      projection.dispose();
    }
  });

  test("filters by selected and stored provider and model identity", () => {
    const now = Date.now();
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    const store: Record<string, SessionEntry> = {
      "agent:main:inherited-default": {
        sessionId: "sess-inherited-default",
        updatedAt: now,
        label: "Inherited default",
      } as SessionEntry,
      "agent:main:override": {
        sessionId: "sess-override",
        updatedAt: now - 1_000,
        label: "Override",
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      } as SessionEntry,
      "agent:main:runtime": {
        sessionId: "sess-runtime",
        updatedAt: now - 2_000,
        label: "Runtime",
        modelProvider: "google",
        model: "gemini-3.1-pro-preview",
      } as SessionEntry,
    };
    const cases = [
      {
        search: "anthropic/claude-sonnet",
        expectedKeys: ["agent:main:inherited-default", "agent:main:runtime"],
      },
      { search: "openai/gpt-5.5", expectedKeys: ["agent:main:override"] },
      { search: "google/gemini", expectedKeys: ["agent:main:runtime"] },
    ] as const;

    for (const testCase of cases) {
      expect(
        selectSessionKeys({
          cfg,
          store,
          opts: { search: testCase.search },
          now,
        }),
      ).toEqual(testCase.expectedKeys);
    }
  });

  test("matches canonical group titles and kinds before offset selection", () => {
    const store: Record<string, SessionEntry> = Object.fromEntries(
      Array.from({ length: 55 }, (_, index) => [
        `agent:main:filler-${index}`,
        { sessionId: `filler-${index}`, updatedAt: 100 + index },
      ]),
    );
    store["agent:main:slack:channel:target"] = {
      sessionId: "target",
      updatedAt: 1,
      groupChannel: "astronomy",
      space: "observatory",
      displayName: "compact-room-id",
      chatType: "channel",
    };
    expect(
      selectSessionKeys({ store, opts: { search: "observatory #astronomy", limit: 50 } }),
    ).toEqual(["agent:main:slack:channel:target"]);
    expect(selectSessionKeys({ store, opts: { search: "group", limit: 50 } })).toEqual([
      "agent:main:slack:channel:target",
    ]);
    expect(
      selectSessionKeys({ store, opts: { search: "direct", limit: 50, offset: 50 } }),
    ).toHaveLength(5);
  });

  test("ranks by real interaction without heartbeat or cron noise", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "main",
        updatedAt: now - 10_000,
        lastInteractionAt: now - 1_000,
      } as SessionEntry,
      "agent:main:heartbeat-noise": {
        sessionId: "heartbeat-noise",
        updatedAt: now,
        lastInteractionAt: now - 5_000,
        pinnedAt: now,
      } as SessionEntry,
      "agent:main:background-only": {
        sessionId: "background-only",
        updatedAt: now + 1_000,
      } as SessionEntry,
      "agent:main:main:heartbeat": {
        sessionId: "isolated-heartbeat",
        updatedAt: now + 3_000,
        lastInteractionAt: now + 3_000,
        heartbeatIsolatedBaseSessionKey: "agent:main:main",
      } as SessionEntry,
      "agent:main:cron:job-1:run:run-abc": {
        sessionId: "run-abc",
        updatedAt: now + 2_000,
        lastInteractionAt: now + 2_000,
      } as SessionEntry,
    };

    expect(
      selectSessionKeys({
        store,
        opts: { requireLastInteraction: true, sortBy: "lastInteractionAt" },
        now,
      }),
    ).toEqual(["agent:main:main", "agent:main:heartbeat-noise"]);
  });
});
