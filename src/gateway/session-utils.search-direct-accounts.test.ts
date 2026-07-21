// Session search tests cover direct session configured account display fallbacks.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { listSessionsFromStore } from "./session-utils.js";

function listDirectSession(params: { cfg: OpenClawConfig; directKey: string; search: string }) {
  return listSessionsFromStore({
    cfg: params.cfg,
    storePath: "/tmp/sessions.json",
    store: {
      [params.directKey]: {
        sessionId: "feishu-direct-session",
        updatedAt: Date.now(),
        origin: {
          provider: "feishu",
          label: "ou_8ad348410b",
        },
      } as SessionEntry,
    },
    opts: { search: params.search },
  });
}

function expectSingleDirectSession(params: {
  cfg: OpenClawConfig;
  directKey: string;
  search: string;
  displayName: string;
}) {
  const result = listDirectSession(params);
  expect(result.sessions).toHaveLength(1);
  const session = expectDefined(result.sessions[0], "result.sessions[0] test invariant");
  expect(session.key).toBe(params.directKey);
  expect(session.displayName).toBe(params.displayName);
}

describe("listSessionsFromStore direct account search", () => {
  test("filters direct sessions by configured account display fallback", () => {
    expectSingleDirectSession({
      cfg: {
        session: { mainKey: "main" },
        agents: { list: [{ id: "main", default: true }, { id: "quote" }] },
        channels: { feishu: { accounts: { quote: { name: "Quote Assistant" } } } },
      } as OpenClawConfig,
      directKey: "agent:quote:feishu:direct:ou_8ad348410b",
      search: "assistant",
      displayName: "Quote Assistant",
    });
  });

  test("filters omitted-account direct sessions by configured default account display fallback", () => {
    expectSingleDirectSession({
      cfg: {
        session: { mainKey: "main" },
        agents: { list: [{ id: "main", default: true }] },
        channels: {
          feishu: {
            defaultAccount: "work",
            accounts: {
              work: { name: "Zebra Assistant" },
              main: { name: "Agent Assistant" },
            },
          },
        },
      } as OpenClawConfig,
      directKey: "agent:main:feishu:direct:ou_8ad348410b",
      search: "zebra",
      displayName: "Zebra Assistant",
    });
  });

  test("filters omitted-account direct sessions by non-default agent account before default account", () => {
    expectSingleDirectSession({
      cfg: {
        session: { mainKey: "main" },
        agents: { list: [{ id: "main", default: true }, { id: "quote" }] },
        channels: {
          feishu: {
            defaultAccount: "main",
            accounts: {
              main: { name: "Main Assistant" },
              quote: { name: "Quote Assistant" },
            },
          },
        },
      } as OpenClawConfig,
      directKey: "agent:quote:feishu:direct:ou_8ad348410b",
      search: "quote",
      displayName: "Quote Assistant",
    });
  });

  test("filters resolved-default-agent direct sessions by configured default account", () => {
    expectSingleDirectSession({
      cfg: {
        session: { mainKey: "main" },
        agents: { list: [{ id: "ops", default: true }, { id: "quote" }] },
        channels: {
          feishu: {
            defaultAccount: "work",
            accounts: {
              ops: { name: "Ops Agent Account" },
              work: { name: "Heliotrope Assistant" },
            },
          },
        },
      } as OpenClawConfig,
      directKey: "agent:ops:feishu:direct:ou_8ad348410b",
      search: "heliotrope",
      displayName: "Heliotrope Assistant",
    });
  });

  test("filters direct sessions by normalized configured account display fallback", () => {
    expectSingleDirectSession({
      cfg: {
        session: { mainKey: "main" },
        agents: { list: [{ id: "main", default: true }] },
        channels: {
          feishu: {
            defaultAccount: "Router D",
            accounts: { "router-d": { name: "Router Display" } },
          },
        },
      } as OpenClawConfig,
      directKey: "agent:main:feishu:direct:ou_8ad348410b",
      search: "router",
      displayName: "Router Display",
    });
  });
});
