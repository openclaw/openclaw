import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  CodexCompatibilityRecord,
  CodexEventRecord,
  CodexNativeStatus,
  CodexProposalExecutionResult,
  CodexProposalRecord,
  CodexSessionExport,
} from "../types.ts";

export type CodexState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  codexLoading: boolean;
  codexError: string | null;
  codexStatus: CodexNativeStatus | null;
  codexDoctor: CodexCompatibilityRecord | null;
  codexEventsLoading: boolean;
  codexEventsSessionKey: string | null;
  codexEvents: CodexEventRecord[];
  codexBusyProposalId: string | null;
  codexExecutionResult: CodexProposalExecutionResult | null;
  codexExportText: string | null;
};

export async function loadCodex(state: CodexState, opts: { doctor?: boolean } = {}) {
  if (!state.client || !state.connected || state.codexLoading) {
    return;
  }
  state.codexLoading = true;
  state.codexError = null;
  try {
    state.codexStatus = await state.client.request<CodexNativeStatus>("codex.status", {});
    if (opts.doctor) {
      state.codexDoctor = await state.client.request<CodexCompatibilityRecord>("codex.doctor", {
        record: true,
      });
    }
    const selectedSession =
      state.codexEventsSessionKey ?? state.codexStatus.sessions[0]?.sessionKey ?? null;
    if (selectedSession) {
      await loadCodexEvents(state, selectedSession);
    }
  } catch (error) {
    state.codexError = String(error);
  } finally {
    state.codexLoading = false;
  }
}

export async function runCodexDoctor(state: CodexState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.codexLoading = true;
  state.codexError = null;
  try {
    state.codexDoctor = await state.client.request<CodexCompatibilityRecord>("codex.doctor", {
      record: true,
    });
    state.codexStatus = await state.client.request<CodexNativeStatus>("codex.status", {});
  } catch (error) {
    state.codexError = String(error);
  } finally {
    state.codexLoading = false;
  }
}

export async function loadCodexEvents(state: CodexState, sessionKey: string, limit = 80) {
  if (!state.client || !state.connected || state.codexEventsLoading) {
    return;
  }
  state.codexEventsLoading = true;
  state.codexError = null;
  try {
    state.codexEventsSessionKey = sessionKey;
    state.codexEvents = await state.client.request<CodexEventRecord[]>("codex.events", {
      sessionKey,
      limit,
    });
  } catch (error) {
    state.codexError = String(error);
  } finally {
    state.codexEventsLoading = false;
  }
}

export async function updateCodexProposal(
  state: CodexState,
  id: string,
  status: CodexProposalRecord["status"],
) {
  if (!state.client || !state.connected) {
    return;
  }
  state.codexBusyProposalId = id;
  state.codexError = null;
  try {
    await state.client.request<CodexProposalRecord | null>("codex.proposal.update", {
      id,
      status,
    });
    state.codexStatus = await state.client.request<CodexNativeStatus>("codex.status", {});
  } catch (error) {
    state.codexError = String(error);
  } finally {
    state.codexBusyProposalId = null;
  }
}

export async function executeCodexProposal(
  state: CodexState,
  id: string,
  opts: { route?: string } = {},
) {
  if (!state.client || !state.connected) {
    return;
  }
  state.codexBusyProposalId = id;
  state.codexError = null;
  state.codexExecutionResult = null;
  try {
    const result = await state.client.request<CodexProposalExecutionResult>(
      "codex.proposal.execute",
      {
        id,
        ...(opts.route ? { route: opts.route } : {}),
      },
    );
    state.codexExecutionResult = result;
    state.codexStatus = await state.client.request<CodexNativeStatus>("codex.status", {});
    await loadCodexEvents(state, result.sessionKey);
  } catch (error) {
    state.codexError = String(error);
  } finally {
    state.codexBusyProposalId = null;
  }
}

export async function exportCodexSession(
  state: CodexState,
  sessionKey: string,
  format: "json" | "markdown" = "markdown",
) {
  if (!state.client || !state.connected) {
    return;
  }
  state.codexError = null;
  try {
    const exported = await state.client.request<CodexSessionExport>("codex.session.export", {
      sessionKey,
      format,
      limit: 400,
    });
    state.codexExportText = exported.text;
  } catch (error) {
    state.codexError = String(error);
  }
}
