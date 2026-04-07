import { sanitizeTerminalText } from "../terminal/safe-text.js";

export type ConfigValidationIssueLike = {
  path: string;
  message: string;
};

export function formatInvalidConfigDetails(issues: ConfigValidationIssueLike[]): string {
  return issues
    .map(
      (issue) =>
        `- ${sanitizeTerminalText(issue.path || "<root>")}: ${sanitizeTerminalText(issue.message)}`,
    )
    .join("\n");
}

export function formatInvalidConfigLogMessage(configPath: string, details: string): string {
  return `Invalid config at ${configPath}:\\n${details}`;
}

export function createInvalidConfigError(configPath: string, details: string): Error {
  const error = new Error(`Invalid config at ${configPath}:\n${details}`);
  (error as { code?: string; details?: string }).code = "INVALID_CONFIG";
  (error as { code?: string; details?: string }).details = details;
  return error;
}
