// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createAlwaysConfiguredPluginConfig,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function readFirstPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [mockCall] = mock.mock.calls;
  const call = mockCall?.[0];
  return requireRecord(call);
}

function readMediaAccess(call: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(call.mediaAccess);
}

function registerPolicyPlugin(id = "policydest", accountIds?: string[]) {
  const handleAction = vi.fn<NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>>(
    async ({ mediaAccess }) =>
      jsonResult({
        ok: true,
        hasHostReadCapability: typeof mediaAccess?.readFile === "function",
      }),
  );
  setTestPlugin(
    {
      ...createChannelTestPluginBase({
        id,
        capabilities: { chatTypes: ["direct", "channel"], media: true },
        config: {
          ...createAlwaysConfiguredPluginConfig(),
          ...(accountIds ? { listAccountIds: () => accountIds } : {}),
        },
      }),
      messaging: { targetResolver: { looksLikeId: () => true } },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
    } satisfies ChannelPlugin,
    id,
  );
  return handleAction;
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
  });
  describe("alias-based plugin action dispatch", () => {
    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });
    it("uses requester session channel policy for host-media reads", async () => {
      const handlePolicyCheckedAction = registerPolicyPlugin();

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policydest: {
              enabled: true,
            },
            requestchat: {
              groups: {
                ops: {
                  toolsBySender: {
                    "id:trusted-user": {
                      deny: ["read"],
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policydest",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:requestchat:group:ops",
        dryRun: false,
      });

      const mediaAccess = readMediaAccess(readFirstPluginCall(handlePolicyCheckedAction));
      expect(mediaAccess.readFile).toBeUndefined();
    });

    it("uses requester username policy for host-media reads", async () => {
      const handlePolicyCheckedAction = registerPolicyPlugin();

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policydest: {
              enabled: true,
            },
            requestchat: {
              groups: {
                ops: {
                  toolsBySender: {
                    "username:alice_u": {
                      deny: ["read"],
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policydest",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderUsername: "alice_u",
        sessionKey: "agent:alpha:requestchat:group:ops",
        dryRun: false,
      });

      const mediaAccess = readMediaAccess(readFirstPluginCall(handlePolicyCheckedAction));
      expect(mediaAccess.readFile).toBeUndefined();
    });

    it("uses requester account policy for host-media reads when destination account differs", async () => {
      const handlePolicyCheckedAction = registerPolicyPlugin("policydest", ["destination"]);

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policydest: {
              enabled: true,
            },
            requestchat: {
              accounts: {
                source: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          deny: ["read"],
                        },
                      },
                    },
                  },
                },
                destination: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          allow: ["read"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policydest",
          accountId: "destination",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterAccountId: "source",
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:requestchat:group:ops",
        dryRun: false,
      });

      const pluginCall = readFirstPluginCall(handlePolicyCheckedAction);
      expect(pluginCall.accountId).toBe("destination");
      const mediaAccess = readMediaAccess(pluginCall);
      expect(mediaAccess.readFile).toBeUndefined();
    });

    it("falls back to the resolved account policy when requester account is unavailable", async () => {
      const handlePolicyCheckedAction = registerPolicyPlugin("policychat", ["source"]);

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policychat: {
              enabled: true,
              accounts: {
                source: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          deny: ["read"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policychat",
          accountId: "source",
          target: "group:ops",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:policychat:group:ops",
        dryRun: false,
      });

      const pluginCall = readFirstPluginCall(handlePolicyCheckedAction);
      expect(pluginCall.accountId).toBe("source");
      const mediaAccess = readMediaAccess(pluginCall);
      expect(mediaAccess.readFile).toBeUndefined();
    });
  });
});
