import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  mockSessionsConfig,
  resetMockSessionsConfig,
  runSessionsJson,
  setMockSessionsConfig,
  writeStore,
} from "./sessions.test-helpers.js";

/**
 * Catalog #20 — `model` / `modelProvider` reported as agent-config, not ACP runtime actuals.
 *
 * Bug summary: For ACP-keyed sessions (e.g. `agent:copilot:acp:<uuid>`), the
 * `--json` listing reports the AGENT's configured model
 * (e.g. `model: "gpt-5.3-codex"`, `modelProvider: "microsoft-foundry"`) — but
 * those are the values the openclaw-agent-driven flow would have used. When
 * the same agent runs as an ACP child via `copilot --acp --stdio`, the actual
 * underlying model selection lives inside copilot CLI and is independent of
 * the agent's configured model. The listing happily reports the agent default
 * regardless of whether the session actually ran via ACP.
 *
 * `resolveSessionDisplayModelRef` (`src/commands/sessions-display-model.ts:123-148`)
 * has zero ACP-awareness: it only consults the session entry's persisted
 * `model` / `modelProvider` / `modelOverride` and the agent's configured
 * default. It never inspects the session key.
 *
 * Decided fix shape (catalog #20, mirrors #18): SENTINEL OVERLAY at the call
 * site. When `isAcpSessionKey(row.key)` is true, the JSON-emit path overlays
 * `{ provider: "acpx", model: "copilot-acp" }` on top of the resolver result.
 * The resolver itself stays pure (a config-policy resolver); the call site
 * applies the runtime-aware overlay.
 *
 * NOTE ON DRIVING SURFACE: `resolveSessionDisplayModelRef` is exported, but
 * the bug as observed by operators surfaces through `sessions --json`, so we
 * drive the test end-to-end through `sessionsCommand --json` (mirroring the
 * #19 test pattern). This proves the bug at the actual emit site that
 * operators see, not just in the resolver in isolation.
 */

mockSessionsConfig();

const { sessionsCommand } = await import("./sessions.js");

type SessionsJsonPayload = {
  sessions?: Array<{
    key: string;
    model?: string | null;
    modelProvider?: string | null;
  }>;
};

const ACP_SESSION_KEY = "agent:copilot:acp:86b7b5af-3773-4a56-b244-069d6c5d3db9";
const NON_ACP_SESSION_KEY = "agent:copilot:main";

const AGENT_CONFIGURED_MODEL = "gpt-5.3-codex";
const AGENT_CONFIGURED_PROVIDER = "microsoft-foundry";

/**
 * Mock config with a `copilot` agent whose configured model is
 * `microsoft-foundry/gpt-5.3-codex` (the deployed scenario from the catalog).
 *
 * Both the ACP and the non-ACP session entries below leave `model` /
 * `modelProvider` unset, so `resolveSessionDisplayModelRef` falls through to
 * the agent's configured default. That is precisely the path under test:
 * for ACP sessions the agent default is the WRONG answer.
 */
function mockAgentConfigWithCopilotModel(): void {
  setMockSessionsConfig(() => ({
    agents: {
      list: [
        {
          id: "copilot",
          model: { primary: `${AGENT_CONFIGURED_PROVIDER}/${AGENT_CONFIGURED_MODEL}` },
        },
      ],
      defaults: {
        contextTokens: 200_000,
      },
    },
  }));
}

/**
 * Minimal ACP session entry: just a session id and an updatedAt timestamp.
 * No `model` / `modelProvider` set on the entry — the listing falls through
 * to the agent's configured default, which is the buggy path for ACP keys.
 */
function buildAcpSessionEntry(): SessionEntry {
  return {
    sessionId: "acp-session-id",
    updatedAt: Date.now() - 2 * 60_000,
  };
}

/**
 * Minimal non-ACP session entry, same shape as the ACP entry. Used as the
 * GREEN-control case below. The agent default is the correct answer for
 * non-ACP sessions — those run through the openclaw-agent-driven flow that
 * actually uses the configured model.
 */
function buildNonAcpSessionEntry(): SessionEntry {
  return {
    sessionId: "non-acp-session-id",
    updatedAt: Date.now() - 3 * 60_000,
  };
}

describe("sessionsCommand model/modelProvider display for ACP sessions (catalog #20)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-06T00:00:00Z"));
    mockAgentConfigWithCopilotModel();
  });

  afterEach(() => {
    resetMockSessionsConfig();
    vi.useRealTimers();
  });

  it("RED: ACP session must NOT report the agent-configured model", async () => {
    // RED today. The session is plainly ACP (key has the `:acp:` segment),
    // but `resolveSessionDisplayModelRef` (`src/commands/sessions-display-model.ts:123`)
    // ignores the key and returns the agent default. Operators relying on
    // `sessions --json` model fields see the model the openclaw-agent-driven
    // flow would have used, NOT what copilot actually selected internally
    // when it ran via ACP.
    //
    // The discriminator the fix should consult is `isAcpSessionKey(row.key)`
    // (re-exported from `src/routing/session-key.ts:9`, defined at
    // `src/sessions/session-key-utils.ts:86`). Mirrors catalog #18's overlay
    // pattern.
    const store = writeStore(
      { [ACP_SESSION_KEY]: buildAcpSessionEntry() },
      "sessions-acp-model-display-red",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === ACP_SESSION_KEY);

    expect(
      row,
      `Expected sessionsCommand --json to include a row for ${ACP_SESSION_KEY}; got none.`,
    ).toBeDefined();
    expect(
      row?.model,
      `ACP session ${ACP_SESSION_KEY} reports model="${row?.model}" — that is the agent-configured ` +
        `model (${AGENT_CONFIGURED_MODEL}), not what copilot actually used inside ACP. ` +
        `resolveSessionDisplayModelRef (src/commands/sessions-display-model.ts:123) has zero ` +
        `ACP-awareness; the call site at src/commands/sessions.ts:335 should consult ` +
        `isAcpSessionKey(row.key) and overlay an ACP-runtime sentinel before serialization.`,
    ).not.toBe(AGENT_CONFIGURED_MODEL);
    expect(
      row?.modelProvider,
      `ACP session ${ACP_SESSION_KEY} reports modelProvider="${row?.modelProvider}" — the ` +
        `agent-configured provider (${AGENT_CONFIGURED_PROVIDER}), not the ACP runtime. ` +
        `Same fix site as above: src/commands/sessions-display-model.ts:123 has no key awareness; ` +
        `apply the overlay at the call site using isAcpSessionKey.`,
    ).not.toBe(AGENT_CONFIGURED_PROVIDER);
  });

  it("RED (fix-shape): ACP session should report the ACP runtime sentinel", async () => {
    // RED today; flips GREEN once the catalog-#20 sentinel-overlay fix lands.
    //
    // The catalog's chosen fix shape is option (a): when `isAcpSessionKey(row.key)`
    // is true, overlay `{ provider: "acpx", model: "copilot-acp" }` (or a
    // similar sentinel). This trades model-name accuracy for "this is ACP,
    // not the agent default" clarity. Plumbing the actual copilot-side model
    // selection into the openclaw record would require capturing ACP
    // `session.model_change` events (catalog notes this as deferrable).
    //
    // If the fix author chooses different sentinel names ("acp-runtime" vs
    // "acpx", "copilot-acp" vs "<acp-runtime>"), update both expectations to
    // match. The structural point is that for ACP-keyed sessions the values
    // MUST be different from the agent default and clearly mark the ACP
    // origin.
    const store = writeStore(
      { [ACP_SESSION_KEY]: buildAcpSessionEntry() },
      "sessions-acp-model-display-fix-shape",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === ACP_SESSION_KEY);

    expect(row).toBeDefined();
    expect(
      row?.model,
      `ACP session ${ACP_SESSION_KEY} should resolve model to "copilot-acp" (the catalog-chosen ` +
        `sentinel). Got "${row?.model}". Fix lands at the call site in src/commands/sessions.ts:335 ` +
        `which already has row.key in scope — gate on isAcpSessionKey(row.key) and overlay ` +
        `{ provider: "acpx", model: "copilot-acp" }. Keeps resolveSessionDisplayModelRef pure.`,
    ).toBe("copilot-acp");
    expect(
      row?.modelProvider,
      `ACP session ${ACP_SESSION_KEY} should resolve modelProvider to "acpx". Got ` +
        `"${row?.modelProvider}". Same fix as the model assertion above; the overlay sets both ` +
        `fields together so they remain internally consistent.`,
    ).toBe("acpx");
  });

  it("GREEN control: non-ACP session correctly reports the agent-configured model", async () => {
    // GREEN today. The same agent configuration drives a non-ACP session
    // (`agent:copilot:main`) — and for that session the agent-configured
    // model IS the right answer because the openclaw-agent-driven flow
    // actually runs that model. This control proves:
    //   1. The test infrastructure is exercising the real resolver path
    //      (not a mock that would silently pass either way).
    //   2. The configured-model branch of resolveSessionDisplayModelRef
    //      remains correct for non-ACP keys; the proposed sentinel overlay
    //      must NOT break this case (it should only fire when
    //      isAcpSessionKey(row.key) is true).
    const store = writeStore(
      { [NON_ACP_SESSION_KEY]: buildNonAcpSessionEntry() },
      "sessions-acp-model-display-green-control",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const row = payload.sessions?.find((entry) => entry.key === NON_ACP_SESSION_KEY);

    expect(row).toBeDefined();
    expect(row?.model).toBe(AGENT_CONFIGURED_MODEL);
    expect(row?.modelProvider).toBe(AGENT_CONFIGURED_PROVIDER);
  });
});
