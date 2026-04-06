import { PathGuardError } from "../../security/path-guard.js";

type ToolTextContent = { type: "text"; text: string };

type PolicyDeniedDetails = {
  kind: "policy_denied";
  policy: "PathGuard";
  attemptedAction: string;
  violatedRule: PathGuardError["violatedRule"];
  requestedPath: string;
  resolvedPath?: string;
  workspaceRoot?: string;
  matchedEntry?: string;
  userFacingGuidance: {
    whatIWasTryingToDo: string;
    options: string[];
    configHint: {
      keys: string[];
      note: string;
    };
  };
};

export function pathGuardDeniedToolResult(args: {
  attemptedAction: string;
  whatIWasTryingToDo: string;
  err: PathGuardError;
}): { content: ToolTextContent[]; details: PolicyDeniedDetails } {
  const { err } = args;

  const scopedPolicyKeys = [
    "tools.fs.workspaceOnly",
    "tools.fs.allowedPaths",
    "tools.fs.denyPaths",
  ];

  const ruleHint =
    err.violatedRule === "workspaceOnly"
      ? "It is outside the workspace boundary."
      : err.violatedRule === "denyPaths"
        ? "It matches an explicit deny rule."
        : "It is not included in the allowlist.";

  const resolved = err.resolvedPath ? ` (resolved to: ${err.resolvedPath})` : "";

  const text =
    "Access denied by the system's filesystem policy (PathGuard). I cannot bypass this restriction.\n\n" +
    `What I was trying to do: ${args.whatIWasTryingToDo}\n` +
    `Blocked path: ${err.requestedPath}${resolved}\n` +
    `Reason: ${ruleHint}` +
    (err.matchedEntry ? ` Matched rule: ${err.matchedEntry}` : "") +
    "\n\n" +
    "Options:\n" +
    "- Move/copy the file into the workspace and try again.\n" +
    "- Paste/provide the needed content directly in chat.\n" +
    "- Use a different path that is allowed by policy.\n" +
    "- If you want me to access this location, update the OpenClaw config to allow it (allowedPaths/denyPaths/workspaceOnly).";

  return {
    content: [{ type: "text", text }],
    details: {
      kind: "policy_denied",
      policy: "PathGuard",
      attemptedAction: args.attemptedAction,
      violatedRule: err.violatedRule,
      requestedPath: err.requestedPath,
      resolvedPath: err.resolvedPath,
      workspaceRoot: err.workspaceRoot,
      matchedEntry: err.matchedEntry,
      userFacingGuidance: {
        whatIWasTryingToDo: args.whatIWasTryingToDo,
        options: [
          "Move/copy the file into the workspace and try again.",
          "Paste/provide the needed content directly in chat.",
          "Use a different path that is allowed by policy.",
          "Update OpenClaw config to allow access (allowedPaths/denyPaths/workspaceOnly).",
        ],
        configHint: {
          keys: scopedPolicyKeys,
          note: "Adjust these keys to grant or restrict filesystem access. Deny rules override allow rules.",
        },
      },
    },
  };
}
