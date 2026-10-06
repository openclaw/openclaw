import { expect, it, vi } from "vitest";
import { prepareQualifiedSessionEntryTarget } from "../config/sessions/session-accessor.entry.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sessionEntryReaders from "../config/sessions/session-entry-read-runtime.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveGatewaySessionStoreTargetWithStore,
  withGatewaySessionStoreTarget,
} from "./session-utils-store-lookup.js";
import { withQualifiedGatewaySessionStoreTarget } from "./session-utils-store-retained.js";

it.for(["membership", "explicit", "qualified"] as const)(
  "consumes facts committed before its %s-ordered snapshot",
  async (ordering) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const key = "agent:main:sharing-before-snapshot";
      const scope = { agentId: "main", sessionKey: key, env };
      await replaceSessionEntry(scope, { sessionId: "same-session", updatedAt: 1 });
      const selected =
        ordering === "qualified"
          ? resolveGatewaySessionStoreTargetWithStore({ cfg, key, env, exactRead: true })
          : undefined;
      const qualified = selected
        ? prepareQualifiedSessionEntryTarget(
            {
              ...selected,
              requestedKey: key,
              storeKey: key,
              readSource: selected.capturedReadSource,
            },
            selected.capturedReadSources,
            env,
          )
        : undefined;
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const committedValues: string[] = [];
      const pendingValues = ["first-value", "second-value"];
      const readEntries = sessionEntryReaders.withSessionEntriesFromStoresInWorker;
      const read = vi
        .spyOn(sessionEntryReaders, "withSessionEntriesFromStoresInWorker")
        .mockImplementation(async (inputs, consume, options) => {
          const value = pendingValues.shift();
          if (value) {
            // Real writes win the FIFO before the reader starts its snapshot.
            await runOpenClawAgentWriteAdmission(
              { agentId: "main", path: database.path, env },
              () => {
                if (ordering !== "explicit") {
                  addSessionMember(scope, { identityId: value, addedBy: "owner", addedAt: 1 });
                } else {
                  writeSessionEntry(database, key, {
                    sessionId: "same-session",
                    updatedAt: 2,
                    label: value,
                  });
                }
                committedValues.push(value);
              },
            );
          }
          return readEntries(inputs, consume, options);
        });
      let consumptions = 0;
      try {
        const consume: Parameters<
          typeof withQualifiedGatewaySessionStoreTarget<{ members?: string[]; label?: string }>
        >[0]["consume"] = (target, membership, assertCurrent) => {
          consumptions += 1;
          assertCurrent();
          expect(target.store[key]?.sessionId).toBe("same-session");
          return ordering !== "explicit"
            ? {
                members: membership
                  .get(key)
                  ?.map((member) => member.identityId)
                  .toSorted(),
              }
            : { label: target.store[key]?.label };
        };
        const result =
          qualified && selected
            ? await withQualifiedGatewaySessionStoreTarget({
                target: qualified.target,
                logicalStorePath: selected.storePath,
                env,
                includeMembership: true,
                consume,
              })
            : await withGatewaySessionStoreTarget(
                {
                  cfg,
                  key,
                  env,
                  includeMembership: ordering === "membership",
                  ordered: ordering === "explicit",
                },
                consume,
              );
        expect(result).toEqual(
          ordering !== "explicit"
            ? { members: committedValues.toSorted() }
            : { label: committedValues.at(-1) },
        );
        expect(committedValues).toContain("first-value");
        expect(consumptions).toBe(1);
      } finally {
        read.mockRestore();
        qualified?.release();
      }
    });
  },
);
