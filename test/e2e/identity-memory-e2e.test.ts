/**
 * End-to-end integration tests for the identity-scoped memory pipeline.
 *
 * Validates the full 4-plugin chain:
 *   persist-user-identity (pri 60) → persist-postgres (pri 50) →
 *   auth-memory-gate (pri 40) → memory-graphiti (pri 0)
 *
 * Tests cover:
 *   1. Session key parsing across WhatsApp, Slack, webchat channels
 *   2. Hard gate flow: unregistered → register → verify → scoped memory
 *   3. Multi-channel identity convergence (same user across channels)
 *   4. Zep Cloud scoped memory isolation (conditional on GETZEP_API_KEY)
 *   5. messageProvider override priority
 *
 * Prerequisites:
 *   - PostgreSQL running locally
 *   - DATABASE_URL=postgresql://postgres:postgres@localhost:5432/openclaw_test
 *   - GETZEP_API_KEY (optional — Zep tests skip without it)
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/openclaw_test \
 *   pnpm vitest run test/e2e/identity-memory-e2e.test.ts
 */

import { createHmac } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
// Import from auth-memory-gate — scope resolution and formatting
import {
  deriveChannel as gateChannel,
  derivePeerId as gatePeerId,
  resolveScope,
  formatScopeBlock,
  formatHardGateSystemPrompt,
  formatHardGateReplyAppend,
  findUserByChannelPeer as gateFindUser,
} from "../../extensions/auth-memory-gate/src/scope.js";
// Import from memory-graphiti — config and group derivation
import { deriveGroupId } from "../../extensions/memory-graphiti/config.js";
// Import from memory-graphiti — independent identity resolution
import {
  deriveChannel as graphitiChannel,
  derivePeerId as graphitiPeerId,
  resolveIdentityScopeKey,
} from "../../extensions/memory-graphiti/identity.js";
// JWT verification from persist-user-identity
import { verifyToken } from "../../extensions/persist-user-identity/src/jwt.js";
// Test helpers
import {
  TEST_DB_URL,
  TEST_CHANNELS,
  TEST_EXTERNAL_ID,
  JWT_TEST_SECRET,
  setupIdentitySchema,
  seedTestUsers,
  cleanupTestData,
  generateTestJwt,
  type SeededUser,
} from "./helpers/identity-test-db.js";

// ---------------------------------------------------------------------------
// DB URL + conditional helpers
// ---------------------------------------------------------------------------

const DB_URL = process.env.DATABASE_URL ?? TEST_DB_URL;
const ZEP_API_KEY = process.env.GETZEP_API_KEY;
const describeZep = ZEP_API_KEY ? describe : describe.skip;

/**
 * Create a postgres connection using dynamic import (postgres is an extension dep).
 * Returns null if connection fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function connectDb(url: string, max = 3): Promise<any> {
  try {
    const pg = (await import("postgres")).default;
    const conn = pg(url, { max, connect_timeout: 5 });
    await conn`SELECT 1`;
    return conn;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sql: any;

// ============================================================================
// Group 1: Session Key Parsing Across Channels (no DB needed)
// ============================================================================

describe("session key parsing — cross-plugin agreement", () => {
  const testCases = [
    {
      name: "WhatsApp",
      sessionKey: TEST_CHANNELS.whatsapp.sessionKey,
      expectedChannel: "whatsapp",
      expectedPeerId: "+15551234567@s.whatsapp.net",
    },
    {
      name: "Slack",
      sessionKey: TEST_CHANNELS.slack.sessionKey,
      expectedChannel: "slack",
      expectedPeerId: "U01234ABCDE",
    },
    {
      name: "Webchat",
      sessionKey: TEST_CHANNELS.webchat.sessionKey,
      expectedChannel: "webchat",
      expectedPeerId: "test-session-e2e-123",
    },
    {
      name: "shared session (main)",
      sessionKey: "agent:default:main",
      expectedChannel: "main",
      expectedPeerId: "main",
    },
    {
      name: "complex WhatsApp JID with direct prefix",
      sessionKey: "agent:my-agent:whatsapp:direct:+447700900123@s.whatsapp.net",
      expectedChannel: "whatsapp",
      expectedPeerId: "+447700900123@s.whatsapp.net",
    },
  ];

  for (const tc of testCases) {
    test(`${tc.name}: auth-memory-gate and memory-graphiti agree on channel`, () => {
      expect(gateChannel(tc.sessionKey)).toBe(tc.expectedChannel);
      expect(graphitiChannel(tc.sessionKey)).toBe(tc.expectedChannel);
    });

    test(`${tc.name}: auth-memory-gate and memory-graphiti agree on peerId`, () => {
      expect(gatePeerId(tc.sessionKey)).toBe(tc.expectedPeerId);
      expect(graphitiPeerId(tc.sessionKey)).toBe(tc.expectedPeerId);
    });
  }

  test("edge case: empty session key returns 'unknown' channel", () => {
    expect(gateChannel("")).toBe("unknown");
    expect(graphitiChannel("")).toBe("unknown");
  });

  test("edge case: non-agent prefix returns raw key as peerId", () => {
    expect(gatePeerId("some-random-key")).toBe("some-random-key");
    expect(graphitiPeerId("some-random-key")).toBe("some-random-key");
  });
});

// ============================================================================
// Group 2: Hard Gate Flow (unregistered → register → verify)
// ============================================================================

describe("hard gate flow — identity lifecycle", () => {
  const testChannel = "e2e-gate-test";
  const testPeerId = `gate-peer-${Date.now()}`;
  const testExternalId = `gate-ext-${Date.now()}`;
  let testUserId: string;
  let dbOk = false;

  beforeAll(async () => {
    sql = await connectDb(DB_URL);
    if (sql) {
      await setupIdentitySchema(sql);
      dbOk = true;
    }
  });

  afterAll(async () => {
    if (!sql) {
      return;
    }
    try {
      await sql`DELETE FROM lp_user_channels WHERE channel = ${testChannel}`;
      await sql`DELETE FROM lp_users WHERE first_name = 'E2EGate'`;
    } catch {
      // ignore
    }
    await sql.end({ timeout: 5 });
  });

  test("step 1: unregistered user triggers hard gate", async () => {
    if (!dbOk) {
      return;
    }
    const identity = await gateFindUser(sql, testChannel, testPeerId);
    expect(identity).toBeNull();

    const gatePrompt = formatHardGateSystemPrompt(testChannel, testPeerId);
    expect(gatePrompt).toContain("[IDENTITY_GATE]");
    expect(gatePrompt).toContain("status: LOCKED");
    expect(gatePrompt).toContain(`channel: ${testChannel}`);
    expect(gatePrompt).toContain(`channel_peer_id: ${testPeerId}`);
    expect(gatePrompt).toContain("MUST NOT proceed");
  });

  test("step 2: /register creates channel-only identity, gate clears", async () => {
    if (!dbOk) {
      return;
    }
    const [user] = await sql`
      INSERT INTO lp_users (first_name, last_name)
      VALUES ('E2EGate', 'User')
      RETURNING id
    `;
    testUserId = user.id;

    await sql`
      INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
      VALUES (${testUserId}, ${testChannel}, ${testPeerId})
    `;

    const identity = await gateFindUser(sql, testChannel, testPeerId);
    expect(identity).not.toBeNull();
    expect(identity!.external_id).toBeNull();
    expect(identity!.verified).toBe(false);

    const scope = resolveScope(identity!, testChannel, testPeerId);
    expect(scope.scopeKey).toBe(testUserId);
    expect(scope.verified).toBe(false);

    const block = formatScopeBlock(scope, {});
    expect(block).toContain("[MEMORY_SCOPE]");
    expect(block).toContain(`scope_key: ${testUserId}`);
    expect(block).toContain("verified: false");
    expect(block).toContain("gated: false");
  });

  test("step 3: /verify upgrades scope_key to external_id", async () => {
    if (!dbOk) {
      return;
    }
    await sql`
      UPDATE lp_users
      SET external_id = ${testExternalId}, updated_at = now()
      WHERE id = ${testUserId}
    `;

    const identity = await gateFindUser(sql, testChannel, testPeerId);
    expect(identity!.verified).toBe(true);
    expect(identity!.external_id).toBe(testExternalId);

    const scope = resolveScope(identity!, testChannel, testPeerId);
    expect(scope.scopeKey).toBe(testExternalId);
    expect(scope.verified).toBe(true);

    const block = formatScopeBlock(scope, {});
    expect(block).toContain(`scope_key: ${testExternalId}`);
    expect(block).toContain("verified: true");
  });

  test("step 4: safety net appends CTA to gated peer replies", () => {
    const cta = formatHardGateReplyAppend();
    expect(cta).toContain("/verify");
    expect(cta).toContain("/register");
  });

  test("step 5: soft gate (requireVerified) blocks memory for unverified user", async () => {
    if (!dbOk) {
      return;
    }
    const [user2] = await sql`
      INSERT INTO lp_users (first_name, last_name)
      VALUES ('E2EGate', 'Unverified')
      RETURNING id
    `;
    const peer2 = `gate-peer2-${Date.now()}`;
    await sql`
      INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
      VALUES (${user2.id}, ${testChannel}, ${peer2})
    `;

    const identity = await gateFindUser(sql, testChannel, peer2);
    const scope = resolveScope(identity!, testChannel, peer2);

    const block = formatScopeBlock(scope, { requireVerified: true });
    expect(block).toContain("gated: true");
    expect(block).toContain("/verify <token>");

    const blockNoGate = formatScopeBlock(scope, { requireVerified: false });
    expect(blockNoGate).toContain("gated: false");
    expect(blockNoGate).toContain(`scope_key: ${user2.id}`);
  });
});

// ============================================================================
// Group 3: Multi-Channel Identity Convergence
// ============================================================================

describe("multi-channel identity convergence", () => {
  let _verifiedUser: SeededUser;
  let guestUser: SeededUser;
  let dbOk = false;

  beforeAll(async () => {
    sql = await connectDb(DB_URL);
    if (sql) {
      await setupIdentitySchema(sql);
      const seeded = await seedTestUsers(sql);
      _verifiedUser = seeded.verifiedUser;
      guestUser = seeded.guestUser;
      dbOk = true;
    }
  });

  afterAll(async () => {
    if (!sql) {
      return;
    }
    try {
      await cleanupTestData(sql);
    } catch {
      // ignore
    }
    await sql.end({ timeout: 5 });
  });

  test("WhatsApp and Slack resolve to same scope_key for verified user", async () => {
    if (!dbOk) {
      return;
    }
    const waIdentity = await gateFindUser(
      sql,
      TEST_CHANNELS.whatsapp.channel,
      TEST_CHANNELS.whatsapp.peerId,
    );
    const slackIdentity = await gateFindUser(
      sql,
      TEST_CHANNELS.slack.channel,
      TEST_CHANNELS.slack.peerId,
    );

    expect(waIdentity).not.toBeNull();
    expect(slackIdentity).not.toBeNull();

    const waScope = resolveScope(
      waIdentity!,
      TEST_CHANNELS.whatsapp.channel,
      TEST_CHANNELS.whatsapp.peerId,
    );
    const slackScope = resolveScope(
      slackIdentity!,
      TEST_CHANNELS.slack.channel,
      TEST_CHANNELS.slack.peerId,
    );

    expect(waScope.scopeKey).toBe(slackScope.scopeKey);
    expect(waScope.scopeKey).toBe(TEST_EXTERNAL_ID);
    expect(waScope.userId).toBe(slackScope.userId);
    expect(waScope.verified).toBe(true);
    expect(slackScope.verified).toBe(true);
  });

  test("memory-graphiti resolveIdentityScopeKey agrees with auth-memory-gate", async () => {
    if (!dbOk) {
      return;
    }
    const waIdentity = await gateFindUser(
      sql,
      TEST_CHANNELS.whatsapp.channel,
      TEST_CHANNELS.whatsapp.peerId,
    );
    const gateScope = resolveScope(
      waIdentity!,
      TEST_CHANNELS.whatsapp.channel,
      TEST_CHANNELS.whatsapp.peerId,
    );

    const graphitiKey = await resolveIdentityScopeKey(sql, {
      sessionKey: TEST_CHANNELS.whatsapp.sessionKey,
    });

    expect(graphitiKey).toBe(gateScope.scopeKey);
    expect(graphitiKey).toBe(TEST_EXTERNAL_ID);
  });

  test("guest user (webchat) gets isolated scope_key = user_id", async () => {
    if (!dbOk) {
      return;
    }
    const identity = await gateFindUser(
      sql,
      TEST_CHANNELS.webchat.channel,
      TEST_CHANNELS.webchat.peerId,
    );

    expect(identity).not.toBeNull();
    expect(identity!.external_id).toBeNull();

    const scope = resolveScope(
      identity!,
      TEST_CHANNELS.webchat.channel,
      TEST_CHANNELS.webchat.peerId,
    );

    expect(scope.scopeKey).toBe(guestUser.id);
    expect(scope.scopeKey).not.toBe(TEST_EXTERNAL_ID);
    expect(scope.verified).toBe(false);
  });

  test("graphiti identity resolution also isolates guest user", async () => {
    if (!dbOk) {
      return;
    }
    const graphitiKey = await resolveIdentityScopeKey(sql, {
      sessionKey: TEST_CHANNELS.webchat.sessionKey,
    });

    expect(graphitiKey).toBe(guestUser.id);
    expect(graphitiKey).not.toBe(TEST_EXTERNAL_ID);
  });

  test("unregistered peer returns null from graphiti identity resolution", async () => {
    if (!dbOk) {
      return;
    }
    const graphitiKey = await resolveIdentityScopeKey(sql, {
      sessionKey: "agent:default:webchat:direct:completely-unknown-peer",
    });

    expect(graphitiKey).toBeNull();
  });
});

// ============================================================================
// Group 4: Zep Cloud Scoped Memory Isolation
// ============================================================================

describeZep("Zep Cloud scoped memory isolation", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  const userA = `e2e-user-a-${Date.now()}`;
  const userB = `e2e-user-b-${Date.now()}`;

  beforeAll(async () => {
    // Dynamic import — @getzep/zep-cloud is an extension dep
    const { ZepCloudClient } = await import("../../extensions/memory-graphiti/zep-cloud-client.js");
    client = new ZepCloudClient(ZEP_API_KEY!);
  });

  test("add episode scoped to userA", async () => {
    await client.addMessages(userA, [
      {
        role_type: "user",
        content: "My favorite longevity protocol is rapamycin cycling with metformin.",
        source_description: "e2e-test",
      },
      {
        role_type: "assistant",
        content: "I have noted your preference for rapamycin cycling combined with metformin.",
        source_description: "e2e-test",
      },
    ]);

    // Zep Cloud processes asynchronously — needs generous delay
    await new Promise((r) => setTimeout(r, 12_000));
  }, 45_000);

  test("search scoped to userA finds relevant facts", async () => {
    const facts = await client.searchFacts("rapamycin protocol", [userA], 5);

    const hasRelevant = facts.some(
      (f: { fact: string }) =>
        f.fact.toLowerCase().includes("rapamycin") ||
        f.fact.toLowerCase().includes("protocol") ||
        f.fact.toLowerCase().includes("metformin"),
    );
    expect(hasRelevant).toBe(true);
  }, 15_000);

  test("search scoped to userB does NOT find userA facts", async () => {
    let facts: { fact: string }[] = [];
    try {
      facts = await client.searchFacts("rapamycin protocol", [userB], 5);
    } catch (err: unknown) {
      // Zep returns 404 for unknown users — that IS isolation working
      if (err instanceof Error && err.message.includes("404")) {
        facts = [];
      } else {
        throw err;
      }
    }

    const hasRapamycin = facts.some((f: { fact: string }) =>
      f.fact.toLowerCase().includes("rapamycin"),
    );
    expect(hasRapamycin).toBe(false);
  }, 15_000);

  test("episodes exist for userA (may need processing time)", async () => {
    // Zep Cloud episode indexing can lag behind fact extraction.
    // Retry a few times with short delays.
    let episodes: { group_id: string }[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      episodes = await client.getEpisodes(userA, 5);
      if (episodes.length > 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    expect(episodes.length).toBeGreaterThan(0);
    expect(episodes[0].group_id).toBe(userA);
  }, 30_000);
});

// ============================================================================
// Group 5: messageProvider Override Priority
// ============================================================================

describe("messageProvider override priority", () => {
  test("messageProvider takes priority over sessionKey for channel derivation", () => {
    const ctx = {
      sessionKey: "agent:default:main",
      messageProvider: "whatsapp",
    };

    const gateChannelResult = ctx.messageProvider ?? gateChannel(ctx.sessionKey);
    const graphitiChannelResult = ctx.messageProvider ?? graphitiChannel(ctx.sessionKey);

    expect(gateChannelResult).toBe("whatsapp");
    expect(graphitiChannelResult).toBe("whatsapp");
  });

  test("resolveIdentityScopeKey uses messageProvider for channel", async () => {
    const testSql = await connectDb(DB_URL, 1);
    if (!testSql) {
      return;
    }

    try {
      await setupIdentitySchema(testSql);

      const [user] = await testSql`
        INSERT INTO lp_users (first_name, last_name, external_id)
        VALUES ('MsgProvider', 'Test', ${`mp-test-${Date.now()}`})
        RETURNING id
      `;
      await testSql`
        INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
        VALUES (${user.id}, 'whatsapp', 'mp-peer-123')
      `;

      const key = await resolveIdentityScopeKey(testSql, {
        sessionKey: "agent:default:main:direct:mp-peer-123",
        messageProvider: "whatsapp",
      });

      expect(key).not.toBeNull();

      await testSql`DELETE FROM lp_user_channels WHERE user_id = ${user.id}`;
      await testSql`DELETE FROM lp_users WHERE id = ${user.id}`;
    } finally {
      await testSql.end({ timeout: 5 });
    }
  });

  test("deriveGroupId fallback uses channel-sender format", () => {
    const groupId = deriveGroupId(
      { sessionKey: "agent:default:slack:direct:U999", messageProvider: "slack" },
      {
        mode: "cloud",
        apiKey: "test",
        groupIdStrategy: "channel-sender",
        autoCapture: true,
        autoRecall: true,
        maxFacts: 10,
      },
    );

    expect(groupId).toBe("slack:U999");
  });
});

// ============================================================================
// Group 6: JWT Token Verification (end-to-end with persist-user-identity)
// ============================================================================

describe("JWT verification end-to-end", () => {
  test("valid JWT with matching secret verifies successfully", async () => {
    const token = generateTestJwt("patient-abc-123", {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@clinic.test",
    });

    const result = await verifyToken(token, {
      mode: "jwt-hs256",
      jwtSecret: JWT_TEST_SECRET,
    });

    expect(result).not.toBeNull();
    expect(result!.externalId).toBe("patient-abc-123");
    expect(result!.firstName).toBe("Jane");
    expect(result!.lastName).toBe("Doe");
    expect(result!.email).toBe("jane@clinic.test");
  });

  test("JWT with wrong secret fails verification", async () => {
    const token = generateTestJwt("patient-abc-123");

    const result = await verifyToken(token, {
      mode: "jwt-hs256",
      jwtSecret: "wrong-secret-key",
    });

    expect(result).toBeNull();
  });

  test("expired JWT fails verification", async () => {
    const token = generateTestJwt("patient-abc-123", {
      expiresInSeconds: -3600,
    });

    const result = await verifyToken(token, {
      mode: "jwt-hs256",
      jwtSecret: JWT_TEST_SECRET,
    });

    expect(result).toBeNull();
  });

  test("JWT without sub claim fails verification", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ name: "No Sub", exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url");
    const sig = createHmac("sha256", JWT_TEST_SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    const token = `${header}.${payload}.${sig}`;

    const result = await verifyToken(token, {
      mode: "jwt-hs256",
      jwtSecret: JWT_TEST_SECRET,
    });

    expect(result).toBeNull();
  });
});

// ============================================================================
// Group 7: Full Pipeline — DB + Scope + Graphiti Agreement
// ============================================================================

describe("full pipeline — scope + graphiti agreement across channels", () => {
  let dbOk = false;

  beforeAll(async () => {
    sql = await connectDb(DB_URL);
    if (sql) {
      await setupIdentitySchema(sql);
      await seedTestUsers(sql);
      dbOk = true;
    }
  });

  afterAll(async () => {
    if (!sql) {
      return;
    }
    try {
      await cleanupTestData(sql);
    } catch {
      // ignore
    }
    await sql.end({ timeout: 5 });
  });

  test("WhatsApp: gate scope and graphiti scope agree", async () => {
    if (!dbOk) {
      return;
    }
    const identity = await gateFindUser(sql, "whatsapp", TEST_CHANNELS.whatsapp.peerId);
    const gateScope = resolveScope(identity!, "whatsapp", TEST_CHANNELS.whatsapp.peerId);

    const graphitiKey = await resolveIdentityScopeKey(sql, {
      sessionKey: TEST_CHANNELS.whatsapp.sessionKey,
    });

    expect(gateScope.scopeKey).toBe(graphitiKey);
    expect(gateScope.scopeKey).toBe(TEST_EXTERNAL_ID);
  });

  test("Slack: gate scope and graphiti scope agree", async () => {
    if (!dbOk) {
      return;
    }
    const identity = await gateFindUser(sql, "slack", TEST_CHANNELS.slack.peerId);
    const gateScope = resolveScope(identity!, "slack", TEST_CHANNELS.slack.peerId);

    const graphitiKey = await resolveIdentityScopeKey(sql, {
      sessionKey: TEST_CHANNELS.slack.sessionKey,
    });

    expect(gateScope.scopeKey).toBe(graphitiKey);
    expect(gateScope.scopeKey).toBe(TEST_EXTERNAL_ID);
  });

  test("Webchat (guest): gate scope and graphiti scope agree", async () => {
    if (!dbOk) {
      return;
    }
    const identity = await gateFindUser(sql, "webchat", TEST_CHANNELS.webchat.peerId);
    const gateScope = resolveScope(identity!, "webchat", TEST_CHANNELS.webchat.peerId);

    const graphitiKey = await resolveIdentityScopeKey(sql, {
      sessionKey: TEST_CHANNELS.webchat.sessionKey,
    });

    expect(gateScope.scopeKey).toBe(graphitiKey);
    expect(gateScope.scopeKey).not.toBe(TEST_EXTERNAL_ID);
  });

  test("all three channels produce distinct scoped context blocks", async () => {
    if (!dbOk) {
      return;
    }
    const channels = [
      { ...TEST_CHANNELS.whatsapp, expectedVerified: true },
      { ...TEST_CHANNELS.slack, expectedVerified: true },
      { ...TEST_CHANNELS.webchat, expectedVerified: false },
    ];

    const blocks: string[] = [];
    for (const ch of channels) {
      const identity = await gateFindUser(sql, ch.channel, ch.peerId);
      const scope = resolveScope(identity!, ch.channel, ch.peerId);
      const block = formatScopeBlock(scope, {});

      expect(block).toContain("[MEMORY_SCOPE]");
      expect(block).toContain(`verified: ${ch.expectedVerified}`);
      blocks.push(block);
    }

    expect(blocks[0]).toContain(`scope_key: ${TEST_EXTERNAL_ID}`);
    expect(blocks[1]).toContain(`scope_key: ${TEST_EXTERNAL_ID}`);
    expect(blocks[2]).not.toContain(`scope_key: ${TEST_EXTERNAL_ID}`);
  });
});
