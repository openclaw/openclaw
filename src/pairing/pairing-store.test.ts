import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { deleteOpenClawStateKvScope } from "../state/openclaw-state-kv.js";
import { readOpenClawStateKvJson, writeOpenClawStateKvJson } from "../state/openclaw-state-kv.js";
import { withEnvAsync } from "../test-utils/env.js";

vi.mock("../channels/plugins/pairing.js", () => ({
  getPairingAdapter: () => null,
}));

import {
  addChannelAllowFromStoreEntry,
  clearPairingAllowFromReadCacheForTest,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  readChannelAllowFromStoreSync,
  removeChannelAllowFromStoreEntry,
  upsertChannelPairingRequest,
} from "./pairing-store.js";

let fixtureRoot = "";
let caseId = 0;
type RandomIntSync = (minOrMax: number, max?: number) => number;
type ChannelPairingTestState = {
  version: 1;
  requests: Array<Record<string, unknown>>;
  allowFrom?: Record<string, string[]>;
};

let randomIntSpy: MockInstance<RandomIntSync>;
let nextRandomInt = 0;

beforeAll(() => {
  fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-pairing-"));
});

afterAll(() => {
  if (fixtureRoot) {
    fsSync.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearPairingAllowFromReadCacheForTest();
  nextRandomInt = 0;
  randomIntSpy ??= vi.spyOn(crypto, "randomInt") as unknown as MockInstance<RandomIntSync>;
  setDefaultRandomIntMock();
});

afterAll(() => {
  randomIntSpy?.mockRestore();
});

function setDefaultRandomIntMock() {
  randomIntSpy.mockImplementation((minOrMax: number, max?: number) => {
    const min = max === undefined ? 0 : minOrMax;
    const upper = max === undefined ? minOrMax : max;
    const span = Math.max(upper - min, 1);
    return min + (nextRandomInt++ % span);
  });
}

function requireFirstPairingRequest(
  requests: Awaited<ReturnType<typeof listChannelPairingRequests>>,
) {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (!request) {
    throw new Error("expected pairing request");
  }
  return request;
}

async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>) {
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  fsSync.mkdirSync(dir, { recursive: true });
  return await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => await fn(dir));
}

function resolveAllowFromFilePath(stateDir: string, channel: string, accountId?: string) {
  const suffix = accountId ? `-${accountId}` : "";
  return path.join(resolveOAuthDir(process.env, stateDir), `${channel}${suffix}-allowFrom.json`);
}

function clearOAuthFixtures(stateDir: string) {
  clearPairingAllowFromReadCacheForTest();
  fsSync.rmSync(resolveOAuthDir(process.env, stateDir), { recursive: true, force: true });
  deleteOpenClawStateKvScope("pairing.channel", {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

function readChannelPairingTestState(stateDir: string, channel: string): ChannelPairingTestState {
  return (
    (readOpenClawStateKvJson("pairing.channel", channel, {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    }) as ChannelPairingTestState | undefined) ?? {
      version: 1,
      requests: [],
      allowFrom: {},
    }
  );
}

function writeChannelPairingTestState(
  stateDir: string,
  channel: string,
  state: ChannelPairingTestState,
) {
  writeOpenClawStateKvJson("pairing.channel", channel, state, {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

async function writeAllowFromFixture(params: {
  stateDir: string;
  channel: string;
  allowFrom: string[];
  accountId?: string;
}) {
  const state = readChannelPairingTestState(params.stateDir, params.channel);
  state.allowFrom ??= {};
  state.allowFrom[params.accountId ?? DEFAULT_ACCOUNT_ID] = params.allowFrom;
  writeChannelPairingTestState(params.stateDir, params.channel, state);
}

async function createTelegramPairingRequest(accountId: string, id = "12345") {
  const created = await upsertChannelPairingRequest({
    channel: "telegram",
    accountId,
    id,
  });
  expect(created.created).toBe(true);
  return created;
}

async function seedTelegramAllowFromFixtures(params: {
  stateDir: string;
  scopedAccountId: string;
  scopedAllowFrom: string[];
  legacyAllowFrom?: string[];
}) {
  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    allowFrom: params.legacyAllowFrom ?? ["1001"],
  });
  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    accountId: params.scopedAccountId,
    allowFrom: params.scopedAllowFrom,
  });
}

async function expectAccountScopedEntryIsolated(entry: string, accountId = "yy") {
  const accountScoped = await readChannelAllowFromStore("telegram", process.env, accountId);
  const channelScoped = await readChannelAllowFromStore(
    "telegram",
    process.env,
    DEFAULT_ACCOUNT_ID,
  );
  expect(accountScoped).toContain(entry);
  expect(channelScoped).not.toContain(entry);
}

async function seedDefaultAccountAllowFromFixture(stateDir: string) {
  await seedTelegramAllowFromFixtures({
    stateDir,
    scopedAccountId: DEFAULT_ACCOUNT_ID,
    scopedAllowFrom: ["1002"],
  });
}

async function withMockRandomInt(params: {
  initialValue?: number;
  sequence?: number[];
  fallbackValue?: number;
  run: () => Promise<void>;
}) {
  try {
    if (params.initialValue !== undefined) {
      randomIntSpy.mockReturnValue(params.initialValue);
    }

    if (params.sequence) {
      let idx = 0;
      randomIntSpy.mockImplementation(() => params.sequence?.[idx++] ?? params.fallbackValue ?? 1);
    }

    await params.run();
  } finally {
    setDefaultRandomIntMock();
  }
}

async function expectAllowFromReadConsistencyCase(params: {
  accountId?: string;
  expected: readonly string[];
  expectedLegacy?: readonly string[];
}) {
  const asyncScoped = await readChannelAllowFromStore("telegram", process.env, params.accountId);
  const syncScoped = readChannelAllowFromStoreSync("telegram", process.env, params.accountId);
  expect(asyncScoped).toEqual(params.expected);
  expect(syncScoped).toEqual(params.expected);
  if (params.expectedLegacy) {
    expect(await readChannelAllowFromStore("telegram", process.env, DEFAULT_ACCOUNT_ID)).toEqual(
      params.expectedLegacy,
    );
    expect(readChannelAllowFromStoreSync("telegram", process.env, DEFAULT_ACCOUNT_ID)).toEqual(
      params.expectedLegacy,
    );
  }
}

async function expectPendingPairingRequestsIsolatedByAccount(params: {
  sharedId: string;
  firstAccountId: string;
  secondAccountId: string;
}) {
  const first = await upsertChannelPairingRequest({
    channel: "telegram",
    accountId: params.firstAccountId,
    id: params.sharedId,
  });
  const second = await upsertChannelPairingRequest({
    channel: "telegram",
    accountId: params.secondAccountId,
    id: params.sharedId,
  });

  expect(first.created).toBe(true);
  expect(second.created).toBe(true);
  expect(second.code).not.toBe(first.code);

  const firstList = await listChannelPairingRequests(
    "telegram",
    process.env,
    params.firstAccountId,
  );
  const secondList = await listChannelPairingRequests(
    "telegram",
    process.env,
    params.secondAccountId,
  );
  expect(requireFirstPairingRequest(firstList).code).toBe(first.code);
  expect(requireFirstPairingRequest(secondList).code).toBe(second.code);
}

describe("pairing store", () => {
  it("handles pending pairing request lifecycle and limits", async () => {
    await withTempStateDir(async (stateDir) => {
      const first = await upsertChannelPairingRequest({
        channel: "demo-pairing-a",
        id: "u1",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      const second = await upsertChannelPairingRequest({
        channel: "demo-pairing-a",
        id: "u1",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.code).toBe(first.code);
      const reusedList = await listChannelPairingRequests("demo-pairing-a");
      expect(requireFirstPairingRequest(reusedList).code).toBe(first.code);

      const created = await upsertChannelPairingRequest({
        channel: "demo-pairing-b",
        id: "+15550001111",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(created.created).toBe(true);
      const parsed = readChannelPairingTestState(stateDir, "demo-pairing-b");
      const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const requests = (parsed.requests ?? []).map((entry) =>
        Object.assign({}, entry, { createdAt: expiredAt, lastSeenAt: expiredAt }),
      );
      writeChannelPairingTestState(stateDir, "demo-pairing-b", {
        ...parsed,
        requests,
      });
      expect(await listChannelPairingRequests("demo-pairing-b")).toHaveLength(0);
      const next = await upsertChannelPairingRequest({
        channel: "demo-pairing-b",
        id: "+15550001111",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(next.created).toBe(true);

      const ids = ["+15550000001", "+15550000002", "+15550000003"];
      for (const id of ids) {
        const capped = await upsertChannelPairingRequest({
          channel: "demo-pairing-c",
          id,
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(capped.created).toBe(true);
      }
      const blocked = await upsertChannelPairingRequest({
        channel: "demo-pairing-c",
        id: "+15550000004",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(blocked.created).toBe(false);
      const listIds = (await listChannelPairingRequests("demo-pairing-c")).map((entry) => entry.id);
      expect(listIds).toEqual(["+15550000001", "+15550000002", "+15550000003"]);

      const createdAt = new Date().toISOString();
      writeChannelPairingTestState(stateDir, "demo-pairing-d", {
        version: 1,
        requests: ids.map((id, index) => ({
          id,
          code: `AAAAAAA${String.fromCharCode(66 + index)}`,
          createdAt,
          lastSeenAt: createdAt,
        })),
      });
      const legacyBlocked = await upsertChannelPairingRequest({
        channel: "demo-pairing-d",
        id: "+15550000004",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(legacyBlocked.created).toBe(false);
      const legacyList = await listChannelPairingRequests("demo-pairing-d");
      expect(legacyList.map((entry) => entry.id)).toEqual(ids);
    });
  });

  it("regenerates when a generated code collides", async () => {
    await withTempStateDir(async () => {
      await withMockRandomInt({
        initialValue: 0,
        run: async () => {
          const first = await upsertChannelPairingRequest({
            channel: "telegram",
            id: "123",
            accountId: DEFAULT_ACCOUNT_ID,
          });
          expect(first.code).toBe("AAAAAAAA");

          await withMockRandomInt({
            sequence: Array(8).fill(0).concat(Array(8).fill(1)),
            fallbackValue: 1,
            run: async () => {
              const second = await upsertChannelPairingRequest({
                channel: "telegram",
                id: "456",
                accountId: DEFAULT_ACCOUNT_ID,
              });
              expect(second.code).toBe("BBBBBBBB");
            },
          });
        },
      });
    });
  });

  it("reports unique code exhaustion without exposing reserved codes", async () => {
    await withTempStateDir(async () => {
      await withMockRandomInt({
        initialValue: 0,
        run: async () => {
          const first = await upsertChannelPairingRequest({
            channel: "telegram",
            id: "123",
            accountId: DEFAULT_ACCOUNT_ID,
          });
          expect(first.code).toBe("AAAAAAAA");

          await expect(
            upsertChannelPairingRequest({
              channel: "telegram",
              id: "456",
              accountId: DEFAULT_ACCOUNT_ID,
            }),
          ).rejects.toThrow(
            "failed to generate unique pairing code after 500 attempts; existing code count: 1",
          );
        },
      });
    });
  });

  it("keeps allowFrom account-scoped across manual and pairing-code approvals", async () => {
    await withTempStateDir(async () => {
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });
      await expectAccountScopedEntryIsolated("12345");

      const created = await createTelegramPairingRequest("yy", "67890");
      const approved = await approveChannelPairingCode({
        channel: "telegram",
        code: created.code,
      });
      expect(approved?.id).toBe("67890");
      await expectAccountScopedEntryIsolated("67890");

      const filtered = await createTelegramPairingRequest("yy", "filtered");
      await expect(
        approveChannelPairingCode({
          channel: "telegram",
          code: "   ",
        }),
      ).resolves.toBeNull();
      await expect(
        approveChannelPairingCode({
          channel: "telegram",
          code: filtered.code,
          accountId: "zz",
        }),
      ).resolves.toBeNull();
      const pending = await listChannelPairingRequests("telegram");
      expect(pending.map((entry) => entry.id)).toEqual(["filtered"]);

      const removed = await removeChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });
      expect(removed.changed).toBe(true);
      expect(removed.allowFrom).toEqual(["67890"]);

      const removedAgain = await removeChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });
      expect(removedAgain.changed).toBe(false);
      expect(removedAgain.allowFrom).toEqual(["67890"]);
    });
  });

  it("stores allowFrom approvals in SQLite without writing legacy files", async () => {
    await withTempStateDir(async (stateDir) => {
      const result = await addChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });

      expect(result).toEqual({ changed: true, allowFrom: ["12345"] });
      expect(await readChannelAllowFromStore("telegram", process.env, "yy")).toEqual(["12345"]);
      expect(fsSync.existsSync(resolveAllowFromFilePath(stateDir, "telegram", "yy"))).toBe(false);
    });
  });

  it("reads allowFrom variants with account-scoped isolation", async () => {
    await withTempStateDir(async (stateDir) => {
      for (const { setup, accountId, expected, expectedLegacy } of [
        {
          setup: async () => {
            await seedTelegramAllowFromFixtures({
              stateDir,
              scopedAccountId: "yy",
              scopedAllowFrom: [" 1003 ", "*", "1003"],
              legacyAllowFrom: ["1001", "*", "1002", "1001"],
            });
          },
          accountId: "yy",
          expected: ["1003"],
          expectedLegacy: ["1001", "1002"],
        },
        {
          setup: async () => {
            await seedTelegramAllowFromFixtures({
              stateDir,
              scopedAccountId: "yy",
              scopedAllowFrom: [],
            });
          },
          accountId: "yy",
          expected: [],
        },
        {
          setup: async () => {
            await writeAllowFromFixture({
              stateDir,
              channel: "telegram",
              allowFrom: ["1001"],
            });
            const malformedScopedPath = resolveAllowFromFilePath(stateDir, "telegram", "yy");
            fsSync.mkdirSync(path.dirname(malformedScopedPath), { recursive: true });
            fsSync.writeFileSync(malformedScopedPath, "{ this is not json\n", "utf8");
          },
          accountId: "yy",
          expected: [],
        },
        {
          setup: async () => {
            await seedDefaultAccountAllowFromFixture(stateDir);
          },
          accountId: DEFAULT_ACCOUNT_ID,
          expected: ["1002"],
        },
        {
          setup: async () => {
            await seedDefaultAccountAllowFromFixture(stateDir);
          },
          accountId: undefined,
          expected: ["1002"],
        },
      ] as const) {
        clearOAuthFixtures(stateDir);
        await setup();
        await expectAllowFromReadConsistencyCase({
          ...(accountId !== undefined ? { accountId } : {}),
          expected,
          ...(expectedLegacy !== undefined ? { expectedLegacy } : {}),
        });
      }
    });
  });

  it("keeps pending pairing requests isolated by account", async () => {
    await withTempStateDir(async (stateDir) => {
      await expectPendingPairingRequestsIsolatedByAccount({
        sharedId: "12345",
        firstAccountId: "alpha",
        secondAccountId: "beta",
      });

      clearOAuthFixtures(stateDir);
      for (const accountId of ["alpha", "beta", "gamma"]) {
        const created = await upsertChannelPairingRequest({
          channel: "telegram",
          accountId,
          id: `pending-${accountId}`,
        });
        expect(created.created).toBe(true);
      }

      const delta = await upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "delta",
        id: "pending-delta",
      });
      expect(delta.created).toBe(true);

      const deltaList = await listChannelPairingRequests("telegram", process.env, "delta");
      const allPending = await listChannelPairingRequests("telegram");
      expect(deltaList.map((entry) => entry.id)).toEqual(["pending-delta"]);
      expect(allPending.map((entry) => entry.id)).toEqual([
        "pending-alpha",
        "pending-beta",
        "pending-gamma",
        "pending-delta",
      ]);
    });
  });

  it("reads latest SQLite allowFrom entries without file cache invalidation", async () => {
    await withTempStateDir(async (stateDir) => {
      await writeAllowFromFixture({
        stateDir,
        channel: "telegram",
        accountId: "yy",
        allowFrom: ["1001"],
      });
      expect(await readChannelAllowFromStore("telegram", process.env, "yy")).toEqual(["1001"]);
      expect(readChannelAllowFromStoreSync("telegram", process.env, "yy")).toEqual(["1001"]);

      await writeAllowFromFixture({
        stateDir,
        channel: "telegram",
        accountId: "yy",
        allowFrom: ["10022"],
      });
      expect(await readChannelAllowFromStore("telegram", process.env, "yy")).toEqual(["10022"]);
      expect(readChannelAllowFromStoreSync("telegram", process.env, "yy")).toEqual(["10022"]);
    });
  });
});
