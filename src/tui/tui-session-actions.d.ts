import type { TUI } from "@mariozechner/pi-tui";
import type { SessionsPatchResult } from "../gateway/protocol/index.js";
import type { ChatLog } from "./components/chat-log.js";
import type { TuiAgentsList, TuiBackend } from "./tui-backend.js";
import type { TuiOptions, TuiStateAccess } from "./tui-types.js";
type SessionActionBtwPresenter = {
    clear: () => void;
};
type SessionActionContext = {
    client: TuiBackend;
    chatLog: ChatLog;
    btw: SessionActionBtwPresenter;
    tui: TUI;
    opts: TuiOptions;
    state: TuiStateAccess;
    agentNames: Map<string, string>;
    initialSessionInput: string;
    initialSessionAgentId: string | null;
    resolveSessionKey: (raw?: string) => string;
    updateHeader: () => void;
    updateFooter: () => void;
    updateAutocompleteProvider: () => void;
    setActivityStatus: (text: string) => void;
    clearLocalRunIds?: () => void;
};
export declare function createSessionActions(context: SessionActionContext): {
    applyAgentsResult: (result: TuiAgentsList) => void;
    refreshAgents: () => Promise<void>;
    refreshSessionInfo: () => Promise<void>;
    applySessionInfoFromPatch: (result?: SessionsPatchResult | null) => void;
    loadHistory: () => Promise<void>;
    setSession: (rawKey: string) => Promise<void>;
    abortActive: () => Promise<void>;
};
export {};
