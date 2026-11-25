import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "../../test/helpers/promise.js";

const heldSends = new Map<string, ReturnType<typeof createSendHold>>();

function createSendHold() {
  return { entered: createDeferred(), release: createDeferred() };
}

export function holdProofSend(to: string) {
  if (heldSends.has(to)) {
    throw new Error(`Duplicate proof send hold: ${to}`);
  }
  const hold = createSendHold();
  heldSends.set(to, hold);
  return {
    ...hold,
    [Symbol.dispose]() {
      hold.release.resolve();
      heldSends.delete(to);
    },
  };
}

export async function prepareProofSend(to: string) {
  const hold = heldSends.get(to);
  if (!hold) {
    throw new Error(`Missing proof send hold: ${to}`);
  }
  hold.entered.resolve();
  await hold.release.promise;
}

export function releaseProofSends() {
  for (const hold of heldSends.values()) {
    hold.release.resolve();
  }
}

export async function writeSinkPlugin(workspace: string, sinkUrl: string) {
  const directory = path.join(workspace, ".openclaw", "extensions", "provenance-sink");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id: "provenance-sink",
      channels: ["telegram"],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  // The configured plugin owns synthetic channel I/O and group configuration.
  // Core policy composition, action dispatch, and execution admission stay real.
  await fs.writeFile(
    path.join(directory, "index.cjs"),
    `module.exports = {
      id: "provenance-sink",
      register(api) {
        const post = async (url, body, failure) => {
          const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          if (!response.ok) throw new Error(failure);
          return response;
        };
        api.registerChannel({ plugin: {
          id: "telegram",
          meta: { id: "telegram", label: "Proof sink", selectionLabel: "Proof sink", docsPath: "/proof", blurb: "Isolated proof transport" },
          capabilities: { chatTypes: ["direct", "group"] },
          reload: { configPrefixes: [], noopPrefixes: ["channels.telegram.groups"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({ accountId: "default", enabled: true, configured: true }),
          },
          actions: {
            describeMessageTool: () => ({ actions: ["send"], capabilities: [] }),
            async prepareSendPayload({ to, payload }) {
              if (!to.startsWith("provenance-linked-")) return;
              await post(${JSON.stringify(sinkUrl.replace(/\/sink$/, "/prepare-send"))}, { to }, "Proof send preparation failed");
              return payload;
            },
          },
          groups: {
            resolveToolPolicy: ({ cfg, groupId }) => cfg.channels?.telegram?.groups?.[groupId]?.tools,
          },
          messaging: {
            normalizeTarget: (value) => value,
            targetResolver: { looksLikeId: (value) => value.startsWith("provenance-") },
          },
          outbound: {
            deliveryMode: "direct",
            resolveTarget: ({ to }) => to ? { ok: true, to } : { ok: false, error: new Error("Missing sink target") },
            async sendText({ to, text, accountId }) {
              const response = await post(${JSON.stringify(sinkUrl)}, { to, text, accountId }, "Proof sink rejected delivery");
              return await response.json();
            },
          },
        } });
      },
    };`,
  );
  return directory;
}
