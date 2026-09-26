import fs from "node:fs/promises";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleSystemAgentCommand } from "./commands-system-agent.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

it("returns protected provider guidance through the channel command without a pending change", async () => {
  await withOpenClawTestState(
    { label: "provider-guidance", layout: "state-only" },
    async (state) => {
      const cfg: OpenClawConfig = {
        commands: { text: true, ownerAllowFrom: ["+15555550123"] },
        channels: { whatsapp: { allowFrom: ["+15555550123"] } },
      };
      await state.writeConfig(cfg);
      const context = { From: "+15555550123", SenderId: "+15555550123", AccountId: "fixture" };
      const params = buildCommandTestParams("/openclaw configure model provider", cfg, context);
      expect(params.command.senderIsOwner).toBe(true);
      expect(params.command.isAuthorizedSender).toBe(true);

      expect(await handleSystemAgentCommand(params, true)).toMatchObject({
        shouldContinue: false,
        reply: { text: expect.stringContaining("Settings → Models → Connect provider") },
      });
      expect(
        await handleSystemAgentCommand(buildCommandTestParams("/openclaw yes", cfg, context), true),
      ).toMatchObject({
        shouldContinue: false,
        reply: { text: "No pending OpenClaw rescue change is waiting for approval." },
      });
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(cfg);
    },
  );
});
