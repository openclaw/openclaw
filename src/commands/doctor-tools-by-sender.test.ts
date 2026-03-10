import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  maybeRepairLegacyToolsBySenderKeys,
  scanLegacyToolsBySenderKeys,
} from "./doctor-tools-by-sender.js";

describe("doctor toolsBySender", () => {
  it("finds only legacy untyped toolsBySender keys", () => {
    const hits = scanLegacyToolsBySenderKeys({
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              toolsBySender: {
                owner: { allow: ["exec"] },
                "id:alice": { deny: ["exec"] },
                "username:@ops-bot": { allow: ["fs.read"] },
                "*": { deny: ["exec"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      key: "owner",
      targetKey: "id:owner",
      pathLabel: "channels.whatsapp.groups.123@g.us.toolsBySender",
    });
  });

  it("migrates legacy keys and drops duplicates that already have typed entries", () => {
    const result = maybeRepairLegacyToolsBySenderKeys({
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              toolsBySender: {
                owner: { allow: ["exec"] },
                alice: { deny: ["exec"] },
                "id:owner": { deny: ["exec"] },
                "username:@ops-bot": { allow: ["fs.read"] },
                "*": { deny: ["exec"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    const cfg = result.config as unknown as {
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              toolsBySender: Record<string, { allow?: string[]; deny?: string[] }>;
            };
          };
        };
      };
    };
    const toolsBySender = cfg.channels.whatsapp.groups["123@g.us"].toolsBySender;
    expect(toolsBySender.owner).toBeUndefined();
    expect(toolsBySender.alice).toBeUndefined();
    expect(toolsBySender["id:owner"]).toEqual({ deny: ["exec"] });
    expect(toolsBySender["id:alice"]).toEqual({ deny: ["exec"] });
    expect(toolsBySender["username:@ops-bot"]).toEqual({ allow: ["fs.read"] });
    expect(toolsBySender["*"]).toEqual({ deny: ["exec"] });
    expect(result.changes).toEqual([
      "- channels.whatsapp.groups.123@g.us.toolsBySender: migrated 1 legacy key to typed id: entries (alice -> id:alice).",
      "- channels.whatsapp.groups.123@g.us.toolsBySender: removed 1 legacy key where typed id: entries already existed (owner (kept existing id:owner)).",
    ]);
  });
});
