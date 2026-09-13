// Append identity must survive the redaction-encoding change (#142821 review).
//
// Shipped releases stored bare masks; this branch stores marked ones. The append path
// compares a stored message with the freshly redacted candidate, so a retry that
// carries the same secret must still deduplicate against the pre-upgrade row while a
// genuinely different payload must still conflict.
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { appendTranscriptMessage } from "./session-accessor.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

const SECRET = "sk-pro1234567890wwww";
/** What shipped software stored for `SECRET`: the bare `first6…last4` mask. */
const PRE_UPGRADE_BARE_MASK = "sk-pro…wwww";
const IDEMPOTENCY_KEY = "assistant-retry-after-upgrade";

function seedPreUpgradeRow(params: {
  scope: { agentId: string; env: NodeJS.ProcessEnv; sessionId: string; sessionKey: string };
  content: string;
}): void {
  runOpenClawAgentWriteTransaction((database) => {
    appendTranscriptMessageInTransaction(database, resolveSqliteTranscriptScope(params.scope), {
      // Bytes already stored by the previous release, exactly as they were written then.
      messageAlreadyRedacted: true,
      message: { role: "assistant", content: params.content, idempotencyKey: IDEMPOTENCY_KEY },
    });
  }, params.scope);
}

describe("append idempotency across the redaction encoding change (#142821)", () => {
  it("deduplicates an identical retry against a pre-upgrade row with bare masks", async () => {
    await withOpenClawTestState({ label: "redaction-encoding-upgrade" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionId: "encoding-upgrade",
        sessionKey: "agent:main:encoding-upgrade",
      };
      seedPreUpgradeRow({
        scope,
        content: `Here is your key: ${PRE_UPGRADE_BARE_MASK}`,
      });

      const retried = await appendTranscriptMessage(scope, {
        config: {},
        message: {
          role: "assistant",
          content: `Here is your key: ${SECRET}`,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      });

      expect(retried.appended).toBe(false);
      expect(JSON.stringify(retried.message)).not.toContain(SECRET);
    });
  });

  it("still rejects a conflicting payload under the same idempotency key", async () => {
    await withOpenClawTestState({ label: "redaction-encoding-conflict" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionId: "encoding-conflict",
        sessionKey: "agent:main:encoding-conflict",
      };
      seedPreUpgradeRow({
        scope,
        content: `Here is your key: ${PRE_UPGRADE_BARE_MASK}`,
      });

      await expect(
        appendTranscriptMessage(scope, {
          config: {},
          message: {
            role: "assistant",
            content: "Here is a different answer",
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        }),
      ).rejects.toThrow(/conflicts with the admitted message/u);
    });
  });
});
