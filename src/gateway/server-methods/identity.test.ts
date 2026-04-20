/**
 * Tests for agent.identity.full Gateway method.
 *
 * Uses a temporary workspace directory so the tests do not touch the
 * real ~/.openclaw/workspace.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

import { identityHandlers } from "./identity.js";

// Minimal fakes for the GatewayRequestHandlerOptions shape that
// identity.get actually uses. The real context has many more fields —
// we only populate what the handler touches.
function makeRespond() {
  const calls: Array<{
    ok: boolean;
    payload?: unknown;
    error?: unknown;
    meta?: Record<string, unknown>;
  }> = [];
  const respond = (
    ok: boolean,
    payload?: unknown,
    error?: unknown,
    meta?: Record<string, unknown>,
  ) => {
    calls.push({ ok, payload, error, meta });
  };
  return { respond, calls };
}

async function runIdentityGet(workspacePath: string) {
  const prev = process.env.OPENCLAW_WORKSPACE;
  process.env.OPENCLAW_WORKSPACE = workspacePath;
  try {
    const { respond, calls } = makeRespond();
    // Cast is fine — handler only uses `respond`
    await identityHandlers["agent.identity.full"]!({
      respond,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return calls[0];
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_WORKSPACE;
    else process.env.OPENCLAW_WORKSPACE = prev;
  }
}

describe("agent.identity.full", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-identity-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns available=false when workspace does not exist", async () => {
    const result = await runIdentityGet(path.join(tmpDir, "does-not-exist"));
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      available: false,
      reason: "no_workspace",
    });
  });

  it("returns available=false when IDENTITY.md is missing", async () => {
    const result = await runIdentityGet(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      available: false,
      reason: "no_identity_md",
    });
  });

  it("parses frontmatter and returns raw content when files exist", async () => {
    const identityMd = [
      "---",
      'name: "Mr Claw"',
      "did: did:claw:mrclaw",
      "emoji: 🦀",
      "creature: Crab",
      'vibe: "Security-first engineer"',
      "---",
      "",
      "# Mr Claw",
      "",
      "Body text.",
    ].join("\n");
    const soulMd = "# Soul\n\nI care about clear thinking.\n";

    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), identityMd, "utf-8");
    await fs.writeFile(path.join(tmpDir, "SOUL.md"), soulMd, "utf-8");

    const result = await runIdentityGet(tmpDir);
    expect(result.ok).toBe(true);

    const payload = result.payload as {
      available: boolean;
      name?: string;
      did?: string;
      emoji?: string;
      creature?: string;
      vibe?: string;
      identityRaw?: string;
      soulRaw?: string;
    };

    expect(payload.available).toBe(true);
    expect(payload.name).toBe("Mr Claw");
    expect(payload.did).toBe("did:claw:mrclaw");
    expect(payload.emoji).toBe("🦀");
    expect(payload.creature).toBe("Crab");
    expect(payload.vibe).toBe("Security-first engineer");
    expect(payload.identityRaw).toContain("# Mr Claw");
    expect(payload.soulRaw).toContain("I care about clear thinking");
  });

  it("handles missing SOUL.md gracefully", async () => {
    const identityMd = [
      "---",
      "name: Solo",
      "did: did:claw:solo",
      "---",
      "",
      "# Solo",
    ].join("\n");

    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), identityMd, "utf-8");

    const result = await runIdentityGet(tmpDir);
    expect(result.ok).toBe(true);
    const payload = result.payload as { available: boolean; soulRaw?: string };
    expect(payload.available).toBe(true);
    expect(payload.soulRaw).toBe("");
  });

  it("handles IDENTITY.md without frontmatter", async () => {
    await fs.writeFile(
      path.join(tmpDir, "IDENTITY.md"),
      "# Just a title, no frontmatter\n",
      "utf-8",
    );
    const result = await runIdentityGet(tmpDir);
    expect(result.ok).toBe(true);
    const payload = result.payload as {
      available: boolean;
      name?: string;
      identityRaw?: string;
    };
    expect(payload.available).toBe(true);
    expect(payload.name).toBeUndefined();
    expect(payload.identityRaw).toContain("Just a title");
  });
});
