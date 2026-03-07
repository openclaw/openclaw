/**
 * Test database helpers for identity-scoped memory E2E tests.
 *
 * Provides setup/teardown for the openclaw_test database with identity tables
 * and test data seeding for WhatsApp, Slack, and webchat channels.
 */

import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_DB_URL = "postgresql://postgres:postgres@localhost:5432/syntropy_journals";
const TEST_DB_NAME = "openclaw_test";

export const TEST_DB_URL = `postgresql://postgres:postgres@localhost:5432/${TEST_DB_NAME}`;

export const JWT_TEST_SECRET = "e2e-test-secret-key-for-identity-verification";

export const TEST_CHANNELS = {
  whatsapp: {
    channel: "whatsapp",
    peerId: "+15551234567@s.whatsapp.net",
    sessionKey: "agent:default:whatsapp:direct:+15551234567@s.whatsapp.net",
  },
  slack: {
    channel: "slack",
    peerId: "U01234ABCDE",
    sessionKey: "agent:default:slack:direct:U01234ABCDE",
  },
  webchat: {
    channel: "webchat",
    peerId: "test-session-e2e-123",
    sessionKey: "agent:default:webchat:direct:test-session-e2e-123",
  },
} as const;

export const TEST_EXTERNAL_ID = `e2e-ext-${Date.now()}`;
export const TEST_EXTERNAL_ID_2 = `e2e-ext-2-${Date.now()}`;

// ---------------------------------------------------------------------------
// Database creation / teardown
// ---------------------------------------------------------------------------

/**
 * Create the openclaw_test database if it doesn't exist.
 * Uses sql.unsafe() because CREATE DATABASE cannot run inside a transaction.
 */
export async function createTestDatabase(): Promise<void> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(BASE_DB_URL, { max: 1 });

  try {
    // Check if database already exists
    const existing = await sql`SELECT 1 FROM pg_database WHERE datname = ${TEST_DB_NAME}`;
    if (existing.length === 0) {
      await sql.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Drop the openclaw_test database (for cleanup).
 * Terminates existing connections first.
 */
export async function dropTestDatabase(): Promise<void> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(BASE_DB_URL, { max: 1 });

  try {
    // Terminate existing connections
    await sql`
      SELECT pg_terminate_backend(pg_stat_activity.pid)
      FROM pg_stat_activity
      WHERE pg_stat_activity.datname = ${TEST_DB_NAME}
        AND pid <> pg_backend_pid()
    `;
    await sql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// Schema setup
// ---------------------------------------------------------------------------

/**
 * Create all identity + persistence tables in the test database.
 * Mirrors the schemas from persist-user-identity and persist-postgres.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setupIdentitySchema(sql: any): Promise<void> {
  // lp_users (from persist-user-identity)
  await sql`
    CREATE TABLE IF NOT EXISTS lp_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      external_id VARCHAR(256) UNIQUE,
      first_name VARCHAR(128),
      last_name VARCHAR(128),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  // lp_user_channels (from persist-user-identity)
  await sql`
    CREATE TABLE IF NOT EXISTS lp_user_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES lp_users(id) ON DELETE CASCADE,
      channel VARCHAR(50) NOT NULL,
      channel_peer_id VARCHAR(512) NOT NULL,
      linked_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(channel, channel_peer_id)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_lp_uc_lookup
      ON lp_user_channels (channel, channel_peer_id)
  `;

  // lp_conversations (from persist-postgres)
  await sql`
    CREATE TABLE IF NOT EXISTS lp_conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel VARCHAR(50) NOT NULL,
      session_key VARCHAR(512) NOT NULL UNIQUE,
      started_at TIMESTAMPTZ DEFAULT now(),
      last_message_at TIMESTAMPTZ DEFAULT now(),
      message_count INTEGER DEFAULT 0
    )
  `;

  // lp_messages (from persist-postgres)
  await sql`
    CREATE TABLE IF NOT EXISTS lp_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES lp_conversations(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      metadata JSONB DEFAULT '{}'
    )
  `;
}

// ---------------------------------------------------------------------------
// Test data seeding
// ---------------------------------------------------------------------------

export type SeededUser = {
  id: string;
  externalId: string | null;
  firstName: string;
  lastName: string;
};

/**
 * Seed test users and channel links.
 * Returns the created users for assertion.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedTestUsers(sql: any): Promise<{
  verifiedUser: SeededUser;
  guestUser: SeededUser;
}> {
  // Create a verified user (has external_id) linked to WhatsApp and Slack
  const [verifiedRow] = await sql`
    INSERT INTO lp_users (first_name, last_name, external_id)
    VALUES ('Alice', 'E2E', ${TEST_EXTERNAL_ID})
    RETURNING id, external_id, first_name, last_name
  `;

  // Link verified user to WhatsApp
  await sql`
    INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
    VALUES (${verifiedRow.id}, ${TEST_CHANNELS.whatsapp.channel}, ${TEST_CHANNELS.whatsapp.peerId})
  `;

  // Link verified user to Slack
  await sql`
    INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
    VALUES (${verifiedRow.id}, ${TEST_CHANNELS.slack.channel}, ${TEST_CHANNELS.slack.peerId})
  `;

  // Create a guest user (no external_id) linked to webchat
  const [guestRow] = await sql`
    INSERT INTO lp_users (first_name, last_name)
    VALUES ('Bob', 'Guest')
    RETURNING id, external_id, first_name, last_name
  `;

  await sql`
    INSERT INTO lp_user_channels (user_id, channel, channel_peer_id)
    VALUES (${guestRow.id}, ${TEST_CHANNELS.webchat.channel}, ${TEST_CHANNELS.webchat.peerId})
  `;

  return {
    verifiedUser: {
      id: verifiedRow.id,
      externalId: verifiedRow.external_id,
      firstName: verifiedRow.first_name,
      lastName: verifiedRow.last_name,
    },
    guestUser: {
      id: guestRow.id,
      externalId: null,
      firstName: guestRow.first_name,
      lastName: guestRow.last_name,
    },
  };
}

/**
 * Clean up test data (preserves tables).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function cleanupTestData(sql: any): Promise<void> {
  // Delete in dependency order
  await sql`DELETE FROM lp_messages`;
  await sql`DELETE FROM lp_conversations`;
  await sql`DELETE FROM lp_user_channels`;
  await sql`DELETE FROM lp_users`;
}

// ---------------------------------------------------------------------------
// JWT generation for tests
// ---------------------------------------------------------------------------

/**
 * Generate an HS256 JWT for testing /verify flows.
 * Uses the same format expected by persist-user-identity's jwt.ts.
 */
export function generateTestJwt(
  sub: string,
  opts?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    expiresInSeconds?: number;
  },
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub,
    given_name: opts?.firstName,
    family_name: opts?.lastName,
    email: opts?.email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (opts?.expiresInSeconds ?? 3600),
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", JWT_TEST_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  return `${headerB64}.${payloadB64}.${signature}`;
}
