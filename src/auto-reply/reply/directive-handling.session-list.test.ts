import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSessionRowProjection } from "../../gateway/session-row-projection.js";
import { listProjectedSessions } from "../../gateway/session-utils-list.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

it.each([
  { command: "/verbose full", authorized: true, expected: { verboseLevel: "full" } },
  { command: "/reasoning on", authorized: true, expected: { reasoningLevel: "on" } },
  { command: "/fast on", authorized: true, expected: { fastMode: true } },
  { command: "/verbose full", authorized: false, expected: { verboseLevel: "off" } },
])(
  "keeps resident session rows current after $command (authorized=$authorized)",
  async ({ command, authorized, expected }) => {
    using _ = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = {};
      const scope = { agentId: "main", sessionKey: "agent:main:main" };
      const storePath = resolveSessionStorePathCore(undefined, { agentId: scope.agentId });
      await upsertSessionEntryCore(scope, {
        sessionId: "directive-list",
        updatedAt: 1,
        verboseLevel: "off",
        reasoningLevel: "off",
        fastMode: false,
      });
      const readEntry = () => expectDefined(loadSessionEntryReadOnly(scope), "session entry");
      const projection = await createSessionRowProjection({ cfg });
      try {
        const requestList = () => listProjectedSessions({ projection, client: null, opts: {} });
        const before = await requestList();
        const materializedBefore = projection.materializedCount;
        expect((await requestList()).sessions).toEqual(before.sessions);
        expect(projection.materializedCount).toBe(materializedBefore);
        const sessionEntry = readEntry();
        await handleDirectiveOnly({
          cfg,
          ...scope,
          storePath,
          sessionEntry,
          sessionStore: { [scope.sessionKey]: sessionEntry },
          directives: parseInlineSessionDirectives(command),
          elevatedEnabled: false,
          elevatedAllowed: false,
          defaultProvider: "openai",
          defaultModel: "gpt-5.5",
          provider: "openai",
          model: "gpt-5.5",
          initialModelLabel: "openai/gpt-5.5",
          formatModelSwitchEvent: (label) => label,
          aliasIndex: { byAlias: new Map(), byKey: new Map() },
          allowedModelKeys: new Set(["openai/gpt-5.5"]),
          allowedModelCatalog: [],
          resetModelOverride: false,
          messageProvider: "telegram",
          commandAuthorized: authorized,
        });
        expect(readEntry()).toMatchObject(expected);
        const after = await requestList();
        expect(after).toMatchObject({ sessions: [expect.objectContaining(expected)] });
        expect(projection.materializedCount).toBe(materializedBefore + (authorized ? 1 : 0));
        if (!authorized) {
          expect(after.sessions).toEqual(before.sessions);
        }
        const materializedAfter = projection.materializedCount;
        expect((await requestList()).sessions).toEqual(after.sessions);
        expect(projection.materializedCount).toBe(materializedAfter);
      } finally {
        projection.dispose();
      }
    });
  },
);
