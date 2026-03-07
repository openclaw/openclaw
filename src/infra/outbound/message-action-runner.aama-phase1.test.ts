import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { issueAamaApprovalToken, writeAamaPhase1Fixture } from "../../test-utils/aama-phase1.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resetAamaSpineControlsForTests } from "../aama-spine-controls.js";
import { deliverOutboundPayloads } from "./deliver.js";
import { runMessageAction } from "./message-action-runner.js";
import { executeSendAction } from "./outbound-send-service.js";

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

afterEach(() => {
  resetAamaSpineControlsForTests();
});

async function withAamaFixture(
  test: (context: { root: string; approvalSecret: string }) => Promise<void>,
): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-aama-phase1-"));
  const phase1Root = path.join(tempRoot, "phase1");
  const approvalSecret = "phase1-secret";
  try {
    await writeAamaPhase1Fixture({ root: phase1Root });
    await test({ root: phase1Root, approvalSecret });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

describe("runMessageAction AAMA Phase 1 policy gate", () => {
  it("blocks external send without approval token when enforcement is enabled", async () => {
    await withAamaFixture(async ({ root, approvalSecret }) => {
      await withEnvAsync(
        {
          OPENCLAW_AAMA_PHASE1_ENABLE: "1",
          OPENCLAW_AAMA_PHASE1_ROOT: root,
          OPENCLAW_AAMA_APPROVAL_SECRET: approvalSecret,
        },
        async () => {
          await expect(
            runMessageAction({
              cfg: slackConfig,
              action: "send",
              params: {
                channel: "slack",
                target: "channel:c12345678",
                message: "hello",
              },
              dryRun: true,
              agentId: "main",
            }),
          ).rejects.toThrow(/approval token is required/i);
        },
      );
    });
  });

  it("allows external send when approval token binding is valid", async () => {
    await withAamaFixture(async ({ root, approvalSecret }) => {
      await withEnvAsync(
        {
          OPENCLAW_AAMA_PHASE1_ENABLE: "1",
          OPENCLAW_AAMA_PHASE1_ROOT: root,
          OPENCLAW_AAMA_APPROVAL_SECRET: approvalSecret,
        },
        async () => {
          const nonce = "nonce-001";
          const payload = {
            channel: "slack",
            to: "channel:c12345678",
            message: "hello",
          };
          const approvalToken = issueAamaApprovalToken({
            secret: approvalSecret,
            actor: "main",
            actionType: "send_external_message",
            payload,
            nonce,
          });

          const result = await runMessageAction({
            cfg: slackConfig,
            action: "send",
            params: {
              channel: "slack",
              target: "channel:c12345678",
              message: "hello",
              approvalToken,
              approvalNonce: nonce,
            },
            dryRun: true,
            agentId: "main",
          });

          expect(result.kind).toBe("send");
          if (result.kind !== "send") {
            throw new Error("expected send result");
          }
          expect(result.to).toBe("channel:c12345678");
        },
      );
    });
  });

  it("blocks approval token replay across restarts via durable state", async () => {
    await withAamaFixture(async ({ root, approvalSecret }) => {
      await withEnvAsync(
        {
          OPENCLAW_AAMA_PHASE1_ENABLE: "1",
          OPENCLAW_AAMA_PHASE1_ROOT: root,
          OPENCLAW_AAMA_APPROVAL_SECRET: approvalSecret,
        },
        async () => {
          const nonce = "nonce-replay";
          const payload = {
            channel: "slack",
            to: "channel:c12345678",
            message: "hello",
          };
          const approvalToken = issueAamaApprovalToken({
            secret: approvalSecret,
            actor: "main",
            actionType: "send_external_message",
            payload,
            nonce,
          });

          await runMessageAction({
            cfg: slackConfig,
            action: "send",
            params: {
              channel: "slack",
              target: "channel:c12345678",
              message: "hello",
              approvalToken,
              approvalNonce: nonce,
            },
            dryRun: true,
            agentId: "main",
          });

          resetAamaSpineControlsForTests();

          await expect(
            runMessageAction({
              cfg: slackConfig,
              action: "send",
              params: {
                channel: "slack",
                target: "channel:c12345678",
                message: "hello",
                approvalToken,
                approvalNonce: nonce,
              },
              dryRun: true,
              agentId: "main",
            }),
          ).rejects.toThrow(/already consumed/i);
        },
      );
    });
  });

  it("persists suspension state across restarts and blocks subsequent actions", async () => {
    await withAamaFixture(async ({ root, approvalSecret }) => {
      await withEnvAsync(
        {
          OPENCLAW_AAMA_PHASE1_ENABLE: "1",
          OPENCLAW_AAMA_PHASE1_ROOT: root,
          OPENCLAW_AAMA_APPROVAL_SECRET: approvalSecret,
        },
        async () => {
          await expect(
            runMessageAction({
              cfg: slackConfig,
              action: "send",
              params: {
                channel: "slack",
                target: "channel:c12345678",
                message: "hello",
              },
              dryRun: true,
              agentId: "main",
            }),
          ).rejects.toThrow(/approval token is required/i);

          resetAamaSpineControlsForTests();

          const nonce = "nonce-after-suspend";
          const payload = {
            channel: "slack",
            to: "channel:c12345678",
            message: "hello",
          };
          const approvalToken = issueAamaApprovalToken({
            secret: approvalSecret,
            actor: "main",
            actionType: "send_external_message",
            payload,
            nonce,
          });

          await expect(
            runMessageAction({
              cfg: slackConfig,
              action: "send",
              params: {
                channel: "slack",
                target: "channel:c12345678",
                message: "hello",
                approvalToken,
                approvalNonce: nonce,
              },
              dryRun: true,
              agentId: "main",
            }),
          ).rejects.toThrow(/autonomy is suspended/i);
        },
      );
    });
  });

  it("fails closed and spine-logs bypass attempts", async () => {
    await withAamaFixture(async ({ root, approvalSecret }) => {
      await withEnvAsync(
        {
          OPENCLAW_AAMA_PHASE1_ENABLE: "1",
          OPENCLAW_AAMA_PHASE1_ROOT: root,
          OPENCLAW_AAMA_APPROVAL_SECRET: approvalSecret,
        },
        async () => {
          const nonce = "nonce-bypass";
          const payload = {
            channel: "slack",
            to: "channel:c12345678",
            message: "hello",
          };
          const approvalToken = issueAamaApprovalToken({
            secret: approvalSecret,
            actor: "main",
            actionType: "send_external_message",
            payload,
            nonce,
          });

          await expect(
            runMessageAction({
              cfg: slackConfig,
              action: "send",
              params: {
                channel: "slack",
                target: "channel:c12345678",
                message: "hello",
                approvalToken,
                approvalNonce: nonce,
                allowlistBypass: "true",
              },
              dryRun: true,
              agentId: "main",
            }),
          ).rejects.toThrow(/allowlist bypass attempt blocked/i);

          const eventsPath = path.join(
            root,
            "governance",
            "spine",
            "append_only_audit_log",
            "events.jsonl",
          );
          const raw = await fs.readFile(eventsPath, "utf-8");
          const events = raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { type?: string });
          const eventTypes = events.map((entry) => entry.type);
          expect(eventTypes).toContain("approval_token_bypass_detected");
          expect(eventTypes).toContain("autonomy_suspended");
        },
      );
    });
  });

  it("blocks direct executeSendAction calls without approval token", async () => {
    await withAamaFixture(async ({ root, approvalSecret }) => {
      await withEnvAsync(
        {
          OPENCLAW_AAMA_PHASE1_ENABLE: "1",
          OPENCLAW_AAMA_PHASE1_ROOT: root,
          OPENCLAW_AAMA_APPROVAL_SECRET: approvalSecret,
        },
        async () => {
          await expect(
            executeSendAction({
              ctx: {
                cfg: slackConfig,
                channel: "slack",
                params: {},
                agentId: "main",
                dryRun: true,
              },
              to: "channel:c12345678",
              message: "hello",
            }),
          ).rejects.toThrow(/approval token is required/i);
        },
      );
    });
  });

  it("blocks direct deliverOutboundPayloads calls without approval token", async () => {
    await withAamaFixture(async ({ root, approvalSecret }) => {
      await withEnvAsync(
        {
          OPENCLAW_AAMA_PHASE1_ENABLE: "1",
          OPENCLAW_AAMA_PHASE1_ROOT: root,
          OPENCLAW_AAMA_APPROVAL_SECRET: approvalSecret,
        },
        async () => {
          await expect(
            deliverOutboundPayloads({
              cfg: slackConfig,
              channel: "slack",
              to: "channel:c12345678",
              payloads: [{ text: "hello" }],
            }),
          ).rejects.toThrow(/approval token is required/i);
        },
      );
    });
  });
});
