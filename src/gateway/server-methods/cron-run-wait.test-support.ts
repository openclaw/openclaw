import type { CronStoredJob } from "../../cron/types.js";

/** Caller-lane dependencies exercised through the real cron.run handler. */
export const cronRunWaitCases: readonly {
  name: string;
  job: Partial<CronStoredJob>;
  mainKey?: string;
  waits: boolean;
}[] = [
  { name: "main", job: { sessionTarget: "main" }, waits: false },
  {
    name: "aliased own session",
    job: { sessionTarget: "session:agent:ops:main" },
    mainKey: "work",
    waits: false,
  },
  {
    name: "current-session announce into the caller",
    job: {
      sessionTarget: "current",
      sessionKey: "agent:ops:main",
      delivery: { mode: "announce" },
    },
    waits: false,
  },
  {
    name: "isolated result commit into the caller",
    job: {
      sessionTarget: "isolated",
      sourceConversation: { sessionKey: "agent:ops:main", sessionId: "creator" },
      delivery: { mode: "announce" },
    },
    waits: false,
  },
  {
    name: "script result commit into the caller",
    job: {
      sessionTarget: "isolated",
      sourceConversation: { sessionKey: "agent:ops:main", sessionId: "creator" },
      payload: { kind: "script", script: "return { notify: 'report' };" },
      delivery: { mode: "announce" },
    },
    waits: false,
  },
  {
    // Quiet current jobs run detached and never commit into the conversation.
    name: "quiet current-session",
    job: { sessionTarget: "current", sessionKey: "agent:ops:main", delivery: { mode: "none" } },
    waits: true,
  },
  {
    // The automations tool stamps the creator's session onto non-isolated jobs.
    name: "other named session created from the caller",
    job: { sessionTarget: "session:reports", sessionKey: "agent:ops:main" },
    waits: true,
  },
] as const;
