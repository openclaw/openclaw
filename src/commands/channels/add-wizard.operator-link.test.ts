import { beforeEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import type { SetupChannelsOptions } from "../../channels/plugins/setup-wizard-types.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  linkUserChannelIdentity,
  resolveUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestConfigSnapshot } from "../test-runtime-config-helpers.js";
import { runChannelsAddWizardFlow } from "./add-wizard.js";

const events = vi.hoisted(() => [] as string[]);
const identity = vi.hoisted(() => ({
  channelId: "discord",
  accountId: "team-bot",
  senderId: "100000000000000001",
}));

// mock-isolation: The channel picker is covered elsewhere; this proves the link follows the commit.
vi.mock("../../flows/channel-setup.js", () => ({
  createChannelSetupHooks: () => ({ onPostWriteHook: vi.fn(), runPostWriteHooks: vi.fn() }),
  setupChannels: async (
    cfg: OpenClawConfig,
    _runtime: unknown,
    _prompter: unknown,
    options: SetupChannelsOptions,
  ) => {
    options.onSelection?.(["discord"]);
    options.onAccountId?.("discord", identity.accountId);
    options.operatorProfile?.onLink(identity);
    return { ...cfg, commands: { ownerAllowFrom: ["discord:" + identity.senderId] } };
  },
}));
vi.mock("./plugin-config-persistence.js", () => ({
  persistChannelPluginConfig: async () => {
    events.push("config committed");
    return { path: "/tmp/openclaw.json" };
  },
}));
vi.mock("../agents.config.js", () => ({ buildAgentSummaries: async () => [] }));

beforeEach(() => {
  events.length = 0;
});

async function runFlow(profileId: string) {
  const prompter = createWizardPrompter({
    note: vi.fn(async (message: string) => {
      events.push("note: " + message);
    }),
  });
  await runChannelsAddWizardFlow({
    writeSnapshot: { snapshot: createTestConfigSnapshot({}), writeOptions: {} },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
    prompter,
    initialChannel: "discord",
    operatorProfile: { profileId, label: "Ada" },
  });
}

it("links the operator account to the administrator only after config commits", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const ada = ensureProfileForEmail("ada@example.test");
    await runFlow(ada.id);
    expect(events).toEqual(["config committed", "note: Linked discord:100000000000000001 to Ada."]);
    expect(resolveUserChannelIdentity(identity)?.profileId).toBe(ada.id);
  });
});

it("reports, and keeps, a link owned by another person", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const ada = ensureProfileForEmail("ada@example.test");
    const grace = ensureProfileForEmail("grace@example.test");
    linkUserChannelIdentity(grace.id, identity);
    await runFlow(ada.id);
    expect(events).toEqual([
      "config committed",
      "note: discord:100000000000000001 is already linked to another profile. Unlink it from that profile first.",
    ]);
    expect(resolveUserChannelIdentity(identity)?.profileId).toBe(grace.id);
  });
});
