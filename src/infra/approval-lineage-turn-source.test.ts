// Covers routing approvals from spawned child sessions to their spawner's chat.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { resolveApprovalLineageTurnSource } from "./approval-lineage-turn-source.js";
import { normalizeLegacySessionEntryDelivery } from "./state-migrations.legacy-session-store.js";

const PARENT = "agent:atlas:whatsapp:atlas:direct:+15555550101";
const CHILD = "agent:bdp:dashboard:11111111-1111-4111-8111-111111111111";
const GRANDCHILD = "agent:bdp:subagent:22222222-2222-4222-8222-222222222222";

type Fixture = Partial<SessionEntry> & {
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
};

async function writeStore(
  storePath: string,
  entries: Record<string, Fixture>,
): Promise<OpenClawConfig> {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry(
      { storePath, sessionKey },
      normalizeLegacySessionEntryDelivery({
        sessionId: sessionKey,
        updatedAt: 1,
        ...entry,
      } as SessionEntry),
    );
  }
  return { session: { store: storePath } } as OpenClawConfig;
}

const whatsappParent: Fixture = {
  lastChannel: "whatsapp",
  lastTo: "+15555550101",
  lastAccountId: "atlas",
};

async function withStore(
  entries: Record<string, Fixture>,
  run: (cfg: OpenClawConfig) => void,
): Promise<void> {
  await withTestDir({ prefix: "openclaw-approval-lineage-" }, async (tmpDir) => {
    run(await writeStore(path.join(tmpDir, "sessions.json"), entries));
  });
}

describe("resolveApprovalLineageTurnSource", () => {
  it("routes an agent-driven child approval to the spawner's chat", async () => {
    await withStore({ [PARENT]: whatsappParent, [CHILD]: { spawnedBy: PARENT } }, (cfg) => {
      expect(
        resolveApprovalLineageTurnSource({
          cfg,
          sessionKey: CHILD,
          turnSourceChannel: "webchat",
        }),
      ).toEqual({
        turnSourceChannel: "whatsapp",
        turnSourceTo: "+15555550101",
        turnSourceAccountId: "atlas",
        turnSourceThreadId: null,
      });
    });
  });

  it("walks past ancestors without a chat and prefers the completion owner", async () => {
    await withStore(
      {
        [PARENT]: whatsappParent,
        [CHILD]: { spawnedBy: "agent:atlas:dashboard:other", completionOwnerSessionKey: PARENT },
        [GRANDCHILD]: { spawnedBy: CHILD },
      },
      (cfg) => {
        expect(
          resolveApprovalLineageTurnSource({ cfg, sessionKey: GRANDCHILD })?.turnSourceTo,
        ).toBe("+15555550101");
      },
    );
  });

  it("keeps the request where it is for a reviewing device or a live external turn", async () => {
    await withStore({ [PARENT]: whatsappParent, [CHILD]: { spawnedBy: PARENT } }, (cfg) => {
      expect(
        resolveApprovalLineageTurnSource({
          cfg,
          sessionKey: CHILD,
          turnSourceChannel: "webchat",
          reviewerDeviceIds: ["device-1"],
        }),
      ).toBeNull();
      expect(
        resolveApprovalLineageTurnSource({
          cfg,
          sessionKey: CHILD,
          turnSourceChannel: "slack",
        }),
      ).toBeNull();
    });
  });

  it("ignores sessions with their own chat, plain parent links and cycles", async () => {
    await withStore(
      {
        [PARENT]: whatsappParent,
        [CHILD]: { parentSessionKey: PARENT },
        [GRANDCHILD]: { spawnedBy: GRANDCHILD },
      },
      (cfg) => {
        expect(resolveApprovalLineageTurnSource({ cfg, sessionKey: PARENT })).toBeNull();
        expect(resolveApprovalLineageTurnSource({ cfg, sessionKey: CHILD })).toBeNull();
        expect(resolveApprovalLineageTurnSource({ cfg, sessionKey: GRANDCHILD })).toBeNull();
      },
    );
  });
});
