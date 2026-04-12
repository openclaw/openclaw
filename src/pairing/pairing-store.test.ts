import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  addChannelAllowFromStoreEntry,
  clearPairingAllowFromReadCacheForTest,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  readLegacyChannelAllowFromStore,
  readLegacyChannelAllowFromStoreSync,
  readChannelAllowFromStoreSync,
  removeChannelAllowFromStoreEntry,
  upsertChannelPairingRequest,
} from "./pairing-store.js";

let fixtureRoot = "";
let caseId = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pairing-"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearPairingAllowFromReadCacheForTest();
});

async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>) {
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  await fs.mkdir(dir, { recursive: true });
  return await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => await fn(dir));
}

async function writeJsonFixture(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolvePairingFilePath(stateDir: string, channel: string) {
  return path.join(resolveOAuthDir(process.env, stateDir), `${channel}-pairing.json`);
}

function resolveAllowFromFilePath(stateDir: string, channel: string, accountId?: string) {
  const suffix = accountId ? `-${accountId}` : "";
  return path.join(resolveOAuthDir(process.env, stateDir), `${channel}${suffix}-allowFrom.json`);
}

async function writeAllowFromFixture(params: {
  stateDir: string;
  channel: string;
  allowFrom: string[];
  accountId?: string;
}) {
  await writeJsonFixture(
    resolveAllowFromFilePath(params.stateDir, params.channel, params.accountId),
    {
      version: 1,
      allowFrom: params.allowFrom,
    },
  );
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

async function assertAllowFromCacheInvalidation(params: {
  stateDir: string;
  readAllowFrom: () => Promise<string[]>;
  readSpy: {
    mockRestore: () => void;
  };
}) {
  const first = await params.readAllowFrom();
  const second = await params.readAllowFrom();
  expect(first).toEqual(["1001"]);
  expect(second).toEqual(["1001"]);
  expect(params.readSpy).toHaveBeenCalledTimes(1);

  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    accountId: "yy",
    allowFrom: ["10022"],
  });
  const third = await params.readAllowFrom();
  expect(third).toEqual(["10022"]);
  expect(params.readSpy).toHaveBeenCalledTimes(2);
}

async function expectAccountScopedEntryIsolated(entry: string, accountId = "yy") {
  const accountScoped = await readChannelAllowFromStore("telegram", process.env, accountId);
  const channelScoped = await readLegacyChannelAllowFromStore("telegram");
  expect(accountScoped).toContain(entry);
  expect(channelScoped).not.toContain(entry);
}

async function withAllowFromCacheReadSpy(params: {
  stateDir: string;
  createReadSpy: () => {
    mockRestore: () => void;
  };
  readAllowFrom: () => Promise<string[]>;
}) {
  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    accountId: "yy",
    allowFrom: ["1001"],
  });
  const readSpy = params.createReadSpy();
  await assertAllowFromCacheInvalidation({
    stateDir: params.stateDir,
    readAllowFrom: params.readAllowFrom,
    readSpy,
  });
  readSpy.mockRestore();
}

async function seedDefaultAccountAllowFromFixture(stateDir: string) {
  await seedTelegramAllowFromFixtures({
    stateDir,
    scopedAccountId: DEFAULT_ACCOUNT_ID,
    scopedAllowFrom: ["1002"],
  });
}

async function expectPairingRequestStateCase(params: { run: () => Promise<void> }) {
  await params.run();
}

async function withMockRandomInt(params: {
  initialValue?: number;
  sequence?: number[];
  fallbackValue?: number;
  run: () => Promise<void>;
}) {
  const spy = vi.spyOn(crypto, "randomInt") as unknown as {
    mockReturnValue: (value: number) => void;
    mockImplementation: (fn: () => number) => void;
    mockRestore: () => void;
  };

  try {
    if (params.initialValue !== undefined) {
      spy.mockReturnValue(params.initialValue);
    }

    if (params.sequence) {
      let idx = 0;
      spy.mockImplementation(() => params.sequence?.[idx++] ?? params.fallbackValue ?? 1);
    }

    await params.run();
  } finally {
    spy.mockRestore();
  }
}

async function expectAllowFromReadConsistencyCase(params: {
  accountId?: string;
  expected: readonly string[];
}) {
  const asyncScoped = await readChannelAllowFromStore("telegram", process.env, params.accountId);
  const syncScoped = readChannelAllowFromStoreSync("telegram", process.env, params.accountId);
  expect(asyncScoped).toEqual(params.expected);
  expect(syncScoped).toEqual(params.expected);
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
  expect(firstList).toHaveLength(1);
  expect(secondList).toHaveLength(1);
  expect(firstList[0]?.code).toBe(first.code);
  expect(secondList[0]?.code).toBe(second.code);
}

async function expectScopedAllowFromReadCase(params: {
  stateDir: string;
  legacyAllowFrom: string[];
  scopedAllowFrom: string[];
  accountId: string;
  expectedScoped: string[];
  expectedLegacy: string[];
}) {
  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    allowFrom: params.legacyAllowFrom,
  });
  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    accountId: params.accountId,
    allowFrom: params.scopedAllowFrom,
  });

  const scoped = readChannelAllowFromStoreSync("telegram", process.env, params.accountId);
  const channelScoped = readLegacyChannelAllowFromStoreSync("telegram");
  expect(scoped).toEqual(params.expectedScoped);
  expect(channelScoped).toEqual(params.expectedLegacy);
}

describe("pairing store", () => {
  it.each([
    {
      name: "reuses pending code and reports created=false",
      run: async () => {
        await withTempStateDir(async () => {
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

          const list = await listChannelPairingRequests("demo-pairing-a");
          expect(list).toHaveLength(1);
          expect(list[0]?.code).toBe(first.code);
        });
      },
    },
    {
      name: "expires pending requests after TTL",
      run: async () => {
        await withTempStateDir(async (stateDir) => {
          const created = await upsertChannelPairingRequest({
            channel: "demo-pairing-b",
            id: "+15550001111",
            accountId: DEFAULT_ACCOUNT_ID,
          });
          expect(created.created).toBe(true);

          const filePath = resolvePairingFilePath(stateDir, "demo-pairing-b");
          const raw = await fs.readFile(filePath, "utf8");
          const parsed = JSON.parse(raw) as {
            requests?: Array<Record<string, unknown>>;
          };
          const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
          const requests = (parsed.requests ?? []).map((entry) => ({
            ...entry,
            createdAt: expiredAt,
            lastSeenAt: expiredAt,
          }));
          await writeJsonFixture(filePath, { version: 1, requests });

          const list = await listChannelPairingRequests("demo-pairing-b");
          expect(list).toHaveLength(0);

          const next = await upsertChannelPairingRequest({
            channel: "demo-pairing-b",
            id: "+15550001111",
            accountId: DEFAULT_ACCOUNT_ID,
          });
          expect(next.created).toBe(true);
        });
      },
    },
    {
      name: "caps pending requests at the default limit",
      run: async () => {
        await withTempStateDir(async () => {
          const ids = ["+15550000001", "+15550000002", "+15550000003"];
          for (const id of ids) {
            const created = await upsertChannelPairingRequest({
              channel: "demo-pairing-c",
              id,
              accountId: DEFAULT_ACCOUNT_ID,
            });
            expect(created.created).toBe(true);
          }

          const blocked = await upsertChannelPairingRequest({
            channel: "demo-pairing-c",
            id: "+15550000004",
            accountId: DEFAULT_ACCOUNT_ID,
          });
          expect(blocked.created).toBe(false);

          const list = await listChannelPairingRequests("demo-pairing-c");
          const listIds = list.map((entry) => entry.id);
          expect(listIds).toHaveLength(3);
          expect(listIds).toContain("+15550000001");
          expect(listIds).toContain("+15550000002");
          expect(listIds).toContain("+15550000003");
          expect(listIds).not.toContain("+15550000004");
        });
      },
    },
    {
      name: "counts legacy default-account pending requests before admitting a new one",
      run: async () => {
        await withTempStateDir(async (stateDir) => {
          const createdAt = new Date().toISOString();
          await writeJsonFixture(resolvePairingFilePath(stateDir, "demo-pairing-c"), {
            version: 1,
            requests: [
              {
                id: "+15550000001",
                code: "AAAAAAAB",
                createdAt,
                lastSeenAt: createdAt,
              },
              {
                id: "+15550000002",
                code: "AAAAAAAC",
                createdAt,
                lastSeenAt: createdAt,
              },
              {
                id: "+15550000003",
                code: "AAAAAAAD",
                createdAt,
                lastSeenAt: createdAt,
              },
            ],
          });

          const blocked = await upsertChannelPairingRequest({
            channel: "demo-pairing-c",
            id: "+15550000004",
            accountId: DEFAULT_ACCOUNT_ID,
          });
          expect(blocked.created).toBe(false);

          const list = await listChannelPairingRequests("demo-pairing-c");
          expect(list.map((entry) => entry.id)).toEqual([
            "+15550000001",
            "+15550000002",
            "+15550000003",
          ]);
        });
      },
    },
  ] as const)("$name", async ({ run }) => {
    await expectPairingRequestStateCase({ run });
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

  it.each([
    {
      name: "stores allowFrom entries per account when accountId is provided",
      run: async () => {
        await withTempStateDir(async () => {
          await addChannelAllowFromStoreEntry({
            channel: "telegram",
            accountId: "yy",
            entry: "12345",
          });

          await expectAccountScopedEntryIsolated("12345");
        });
      },
    },
    {
      name: "approves pairing codes into account-scoped allowFrom via pairing metadata",
      run: async () => {
        await withTempStateDir(async () => {
          const created = await createTelegramPairingRequest("yy");

          const approved = await approveChannelPairingCode({
            channel: "telegram",
            code: created.code,
          });
          expect(approved?.id).toBe("12345");

          await expectAccountScopedEntryIsolated("12345");
        });
      },
    },
    {
      name: "filters approvals by account id and ignores blank approval codes",
      run: async () => {
        await withTempStateDir(async () => {
          const created = await createTelegramPairingRequest("yy");

          const blank = await approveChannelPairingCode({
            channel: "telegram",
            code: "   ",
          });
          expect(blank).toBeNull();

          const mismatched = await approveChannelPairingCode({
            channel: "telegram",
            code: created.code,
            accountId: "zz",
          });
          expect(mismatched).toBeNull();

          const pending = await listChannelPairingRequests("telegram");
          expect(pending).toHaveLength(1);
          expect(pending[0]?.id).toBe("12345");
        });
      },
    },
    {
      name: "removes account-scoped allowFrom entries idempotently",
      run: async () => {
        await withTempStateDir(async () => {
          await addChannelAllowFromStoreEntry({
            channel: "telegram",
            accountId: "yy",
            entry: "12345",
          });

          const removed = await removeChannelAllowFromStoreEntry({
            channel: "telegram",
            accountId: "yy",
            entry: "12345",
          });
          expect(removed.changed).toBe(true);
          expect(removed.allowFrom).toEqual([]);

          const removedAgain = await removeChannelAllowFromStoreEntry({
            channel: "telegram",
            accountId: "yy",
            entry: "12345",
          });
          expect(removedAgain.changed).toBe(false);
          expect(removedAgain.allowFrom).toEqual([]);
        });
      },
    },
  ] as const)("$name", async ({ run }) => {
    await expectPairingRequestStateCase({ run });
  });

  it("reads sync allowFrom with account-scoped isolation and wildcard filtering", async () => {
    await withTempStateDir(async (stateDir) => {
      await expectScopedAllowFromReadCase({
        stateDir,
        legacyAllowFrom: ["1001", "*", " 1001 ", "  "],
        scopedAllowFrom: [" 1002 ", "1001", "1002"],
        accountId: "yy",
        expectedScoped: ["1002", "1001"],
        expectedLegacy: ["1001"],
      });
    });
  });

  it.each([
    {
      name: "does not read legacy channel-scoped allowFrom for non-default account ids",
      setup: async (stateDir: string) => {
        await seedTelegramAllowFromFixtures({
          stateDir,
          scopedAccountId: "yy",
          scopedAllowFrom: ["1003"],
          legacyAllowFrom: ["1001", "*", "1002", "1001"],
        });
      },
      accountId: "yy",
      expected: ["1003"],
    },
    {
      name: "does not fall back to legacy allowFrom when scoped file exists but is empty",
      setup: async (stateDir: string) => {
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
      name: "keeps async and sync reads aligned for malformed scoped allowFrom files",
      setup: async (stateDir: string) => {
        await writeAllowFromFixture({
          stateDir,
          channel: "telegram",
          allowFrom: ["1001"],
        });
        const malformedScopedPath = resolveAllowFromFilePath(stateDir, "telegram", "yy");
        await fs.mkdir(path.dirname(malformedScopedPath), { recursive: true });
        await fs.writeFile(malformedScopedPath, "{ this is not json\n", "utf8");
      },
      accountId: "yy",
      expected: [],
    },
    {
      name: "reads legacy channel-scoped allowFrom for default account",
      setup: async (stateDir: string) => {
        await seedDefaultAccountAllowFromFixture(stateDir);
      },
      accountId: DEFAULT_ACCOUNT_ID,
      expected: ["1002", "1001"],
    },
    {
      name: "uses default-account allowFrom when account id is omitted",
      setup: async (stateDir: string) => {
        await seedDefaultAccountAllowFromFixture(stateDir);
      },
      accountId: undefined,
      expected: ["1002", "1001"],
    },
  ] as const)("$name", async ({ setup, accountId, expected }) => {
    await withTempStateDir(async (stateDir) => {
      await setup(stateDir);
      await expectAllowFromReadConsistencyCase({
        ...(accountId !== undefined ? { accountId } : {}),
        expected,
      });
    });
  });

  it.each([
    {
      name: "does not reuse pairing requests across accounts for the same sender id",
      run: async () => {
        await withTempStateDir(async () => {
          await expectPendingPairingRequestsIsolatedByAccount({
            sharedId: "12345",
            firstAccountId: "alpha",
            secondAccountId: "beta",
          });
        });
      },
    },
    {
      name: "does not block a new account when other accounts already filled their own pending slots",
      run: async () => {
        await withTempStateDir(async () => {
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
      },
    },
  ] as const)("$name", async ({ run }) => {
    await expectPairingRequestStateCase({ run });
  });

  it.each([
    {
      label: "async",
      createReadSpy: () => vi.spyOn(fs, "readFile"),
      readAllowFrom: () => readChannelAllowFromStore("telegram", process.env, "yy"),
    },
    {
      label: "sync",
      createReadSpy: () => vi.spyOn(fsSync, "readFileSync"),
      readAllowFrom: async () => readChannelAllowFromStoreSync("telegram", process.env, "yy"),
    },
  ])("reuses cached $label allowFrom reads and invalidates on file updates", async (variant) => {
    await withTempStateDir(async (stateDir) => {
      await withAllowFromCacheReadSpy({
        stateDir,
        createReadSpy: variant.createReadSpy,
        readAllowFrom: variant.readAllowFrom,
      });
    });
  });
});
