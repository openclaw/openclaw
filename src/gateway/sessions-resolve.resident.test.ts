import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";
import { filterAndSortSessionEntries, prepareSessionRowSelection } from "./session-utils-list.js";
import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";

afterEach(() => vi.restoreAllMocks());

const cfg = {
  agents: {
    ownership: "explicit" as const,
    entries: { main: { model: { primary: "openai/gpt-5.5" } } },
  },
};
const key = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";
const scope = { agentId: "main", sessionKey: key };
const entry = {
  sessionId: "resident-resolve",
  updatedAt: 1,
  label: "Original label",
  modelProvider: "ollama",
  model: "qwen3:7b",
};

it("resolves all selectors from one resident projection and sees committed label changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(scope, entry);
    const projection = await createSessionRowProjection({ cfg });
    const resolve = (p: SessionsResolveParams) =>
      resolveSessionKeyFromResolveParams({ cfg, client: null, projection, p });
    try {
      const reads = (["all", "get", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      try {
        for (const p of [
          { key },
          { sessionId: entry.sessionId },
          { label: entry.label },
          { shortId: "12345678" },
          { reference: { key } },
        ]) {
          expect(await resolve(p)).toMatchObject({ ok: true, key, agentId: "main" });
        }
        for (const read of reads) {
          expect(read).not.toHaveBeenCalled();
        }
      } finally {
        for (const read of reads) {
          read.mockRestore();
        }
      }
      replaceSessionEntrySync(scope, { ...entry, label: "Updated label" });
      expect(await resolve({ label: "Updated label" })).toEqual({ ok: true, key, agentId: "main" });
      expect(await resolve({ label: entry.label, allowMissing: true })).toEqual({
        ok: true,
        missing: true,
      });
    } finally {
      projection.dispose();
    }
  });
});

it("searches stored and selected model identities from retained row facts without SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(scope, entry);
    const projection = await createSessionRowProjection({ cfg });
    try {
      const reads = (["all", "get", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      try {
        for (const search of ["Original label", "ollama/qwen3", "openai/gpt-5.5", "direct"]) {
          const opts = { search };
          expect(
            filterAndSortSessionEntries({
              ...prepareSessionRowSelection(projection, opts),
              opts,
              now: Date.now(),
            }).map(([selected]) => selected),
          ).toEqual([key]);
        }
        for (const read of reads) {
          expect(read).not.toHaveBeenCalled();
        }
      } finally {
        for (const read of reads) {
          read.mockRestore();
        }
      }
    } finally {
      projection.dispose();
    }
  });
});

it("resolves authorized exact incognito keys without admitting them to discovery or resident rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const incognitoKey = "agent:main:dashboard:incognito-12345678-0aaa-4000-8000-000000000002";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: incognitoKey },
      { sessionId: "private-resolve", updatedAt: 1, incognito: true, label: "Private" },
    );
    const projection = await createSessionRowProjection({ cfg });
    const client = sharingPolicyClient({ scopes: ["operator.admin"] });
    const resolve = (p: SessionsResolveParams) =>
      resolveSessionKeyFromResolveParams({ cfg, client, projection, p });
    try {
      expect(await resolve({ key: incognitoKey })).toEqual({
        ok: true,
        key: incognitoKey,
        agentId: "main",
      });
      for (const selector of [
        { sessionId: "private-resolve" },
        { label: "Private" },
        { reference: { key: incognitoKey } },
      ]) {
        expect(await resolve({ ...selector, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
      }
      expect(
        await resolveSessionKeyFromResolveParams({
          cfg,
          client: sharingPolicyClient({ user: "viewer" }),
          projection,
          p: { key: incognitoKey, allowMissing: true },
        }),
      ).toEqual({ ok: true, missing: true });
      expect(projection.select().length).toBe(0);
    } finally {
      projection.dispose();
    }
  });
});
