import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.js";
import { upsertSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { readVisibleSessionTranscriptMessageEntries } from "../plugin-sdk/session-transcript-runtime.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import { importSessionCatalogHistory } from "./session-catalog-history-import.js";

type ImportParams = Parameters<typeof importSessionCatalogHistory>[0];
type HistoryPage = Awaited<ReturnType<ImportParams["read"]>>;

async function withHistoryImportStore(
  run: (fixture: {
    importParams: Omit<ImportParams, "read">;
    readMessages: () => ReturnType<typeof readVisibleSessionTranscriptMessageEntries>;
  }) => Promise<void>,
) {
  await withTempHome(
    async (home) => {
      const stateDir = path.join(fs.realpathSync(home), ".openclaw");
      const identity = {
        agentId: "main",
        sessionId: "catalog-import-session",
        sessionKey: "agent:main:catalog-import",
      };
      const supplied = {
        ...identity,
        storePath: path.join(stateDir, "catalog-store", "sessions.json"),
      };
      const competing = {
        ...identity,
        storePath: path.join(stateDir, "runtime-store", "sessions.json"),
      };
      const defaultDatabasePath = path.join(
        stateDir,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      const config = { session: { store: supplied.storePath }, plugins: { enabled: false } };
      const runtimeConfig = {
        session: { store: competing.storePath },
        plugins: { enabled: false },
      };
      const previous = getRuntimeConfigSnapshot();
      const previousSource = getRuntimeConfigSourceSnapshot();
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(runtimeConfig));
      setRuntimeConfigSnapshot(runtimeConfig);
      try {
        for (const scope of [supplied, competing]) {
          await upsertSessionEntry({
            ...scope,
            entry: { sessionId: identity.sessionId, updatedAt: 1 },
          });
        }
        await appendTranscriptMessage(competing, {
          message: { role: "user", content: "Existing runtime transcript", timestamp: 1 },
        });
        expect(fs.existsSync(defaultDatabasePath)).toBe(false);

        await run({
          importParams: {
            ...identity,
            catalogId: "fixture-catalog",
            threadId: "source-thread",
            config,
          },
          readMessages: () => readVisibleSessionTranscriptMessageEntries(supplied),
        });
        expect(await readVisibleSessionTranscriptMessageEntries(competing)).toMatchObject([
          { message: { role: "user", content: "Existing runtime transcript" } },
        ]);
        expect(fs.existsSync(defaultDatabasePath)).toBe(false);
      } finally {
        if (previous) {
          setRuntimeConfigSnapshot(previous, previousSource ?? undefined);
        } else {
          clearRuntimeConfigSnapshot();
        }
      }
    },
    {
      prefix: "openclaw-catalog-import-store-",
      env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") },
    },
  );
}

function historyPage(texts: string[], nextCursor?: string): HistoryPage {
  return {
    hostId: "fixture-host",
    threadId: "source-thread",
    items: texts.map((text) => ({ id: text, type: "userMessage", text })),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

describe("session catalog history import persistence", () => {
  it("imports and deduplicates in the supplied config store without polluting runtime or default stores", async () => {
    await withHistoryImportStore(async ({ importParams, readMessages }) => {
      const params: ImportParams = {
        ...importParams,
        read: async () => ({
          hostId: "fixture-host",
          threadId: "source-thread",
          items: [
            { id: "answer", type: "agentMessage", text: "Imported answer" },
            { id: "prompt", type: "userMessage", text: "Imported prompt" },
          ],
        }),
      };
      await importSessionCatalogHistory(params);
      await importSessionCatalogHistory(params);

      expect(await readMessages()).toMatchObject([
        {
          idempotencyKey: "fixture-catalog-catalog:source-thread:prompt",
          message: { role: "user", content: "Imported prompt" },
        },
        {
          idempotencyKey: "fixture-catalog-catalog:source-thread:answer",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Imported answer" }],
          },
        },
      ]);
    });
  });

  it.each([
    {
      name: "empty cursor cycle",
      pages: [historyPage([], " A/+=? "), historyPage([], "B#/%"), historyPage([], " A/+=? ")],
      expected: [],
    },
    {
      name: "cursor cycle with retained history",
      pages: [
        historyPage(["newest"], " A/+=? "),
        historyPage(["middle"], "B#/%"),
        historyPage(["oldest"], " A/+=? "),
      ],
      expected: ["oldest", "middle", "newest"],
    },
    {
      name: "immediate cursor repetition",
      pages: [historyPage(["newest"], "A"), historyPage(["oldest"], "A")],
      expected: ["oldest", "newest"],
    },
    {
      name: "finite sparse pages",
      pages: [historyPage([], "A"), historyPage([], "B"), historyPage(["history"])],
      expected: ["history"],
    },
  ])(
    "finishes $name and preserves the retained transcript on replay",
    async ({ pages, expected }) => {
      await withHistoryImportStore(async ({ importParams, readMessages }) => {
        const importOnce = async () => {
          let requests = 0;
          await importSessionCatalogHistory({
            ...importParams,
            read: async ({ cursor }) => {
              const page = pages[requests];
              if (!page) {
                throw new Error("History reader exceeded its terminal page");
              }
              expect(cursor).toBe(requests === 0 ? undefined : pages[requests - 1]?.nextCursor);
              requests += 1;
              return page;
            },
          });
          expect(requests).toBe(pages.length);
        };
        await importOnce();
        const stored = await readMessages();
        expect(stored).toMatchObject(
          expected.map((text) => ({ message: { role: "user", content: text } })),
        );
        await importOnce();
        expect(await readMessages()).toEqual(stored);
      });
    },
  );

  it.each([false, true])(
    "bounds distinct empty cursors and retains the final permitted page (has history: %s)",
    async (hasHistory) => {
      await withHistoryImportStore(async ({ importParams, readMessages }) => {
        let requests = 0;
        await importSessionCatalogHistory({
          ...importParams,
          read: async () => {
            requests += 1;
            if (requests > 200) {
              throw new Error("History reader exceeded 200 pages");
            }
            return historyPage(
              hasHistory && requests === 200 ? ["last page"] : [],
              `page-${requests}`,
            );
          },
        });
        expect(requests).toBe(200);
        expect(await readMessages()).toMatchObject(
          hasHistory ? [{ message: { role: "user", content: "last page" } }] : [],
        );
      });
    },
  );

  it.each(["history", "notice"] as const)(
    "refuses fresh %s writes when authority expires during the history read",
    async (kind) => {
      await withHistoryImportStore(async ({ importParams, readMessages }) => {
        const started = createDeferred();
        const page = createDeferred<HistoryPage>();
        let authorized = true;
        const importing = importSessionCatalogHistory({
          ...importParams,
          ...(kind === "notice" ? { continuationNotice: "Copied history" } : {}),
          commitGuard: () => {
            if (!authorized) {
              throw new Error("Catalog authority expired");
            }
          },
          read: () => {
            started.resolve();
            return page.promise;
          },
        });
        const rejected = expect(importing).rejects.toThrow("Catalog authority expired");
        await started.promise;
        authorized = false;
        page.resolve(historyPage(kind === "history" ? ["history"] : []));
        await rejected;
        expect(await readMessages()).toEqual([]);
      });
    },
  );

  it("replays committed history and notices but still guards a later fresh message", async () => {
    await withHistoryImportStore(async ({ importParams, readMessages }) => {
      let authorized = true;
      const commitGuard = vi.fn(() => {
        if (!authorized) {
          throw new Error("Catalog authority expired");
        }
      });
      const params: ImportParams = {
        ...importParams,
        continuationNotice: "Copied history",
        commitGuard,
        read: async () => historyPage(["history"]),
      };
      await importSessionCatalogHistory(params);
      const stored = await readMessages();
      expect(stored).toHaveLength(2);
      expect(commitGuard).toHaveBeenCalledTimes(2);

      authorized = false;
      await importSessionCatalogHistory(params);
      expect(await readMessages()).toEqual(stored);
      expect(commitGuard).toHaveBeenCalledTimes(2);

      await expect(
        importSessionCatalogHistory({
          ...params,
          read: async () => historyPage(["new", "history"]),
        }),
      ).rejects.toThrow("Catalog authority expired");
      expect(await readMessages()).toEqual(stored);
      expect(commitGuard).toHaveBeenCalledTimes(3);
    });
  });
});
