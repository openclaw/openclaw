import {
  MISSING_REPLY_NOTICE_TEXT,
  MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT,
} from "../../agents/reply-completion.js";

export const terminalDiagnosticScenarios = [
  {
    name: "resolved failure",
    timeout: false,
    recordedError: undefined,
    expectedError: "Provider rejected this request.",
    expectedWaitError: "failed",
  },
  {
    name: "resolved timeout",
    timeout: true,
    recordedError: undefined,
    expectedError: "Request timed out before a response was generated.",
    expectedWaitError: "aborted",
  },
  {
    name: "producer lifecycle guidance",
    timeout: false,
    recordedError: "Reconnect the selected provider, then try again.",
    expectedError: "Reconnect the selected provider, then try again.",
    expectedWaitError: "failed",
  },
  ...[MISSING_REPLY_NOTICE_TEXT, MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT].map((notice, index) => ({
    name: `host missing reply ${index}`,
    timeout: false,
    recordedError: notice,
    expectedError: notice,
    expectedWaitError: notice,
  })),
];
