import { sanitizeTerminalText } from "../terminal/safe-text.js";
export function formatInvalidConfigDetails(issues) {
    return issues
        .map((issue) => `- ${sanitizeTerminalText(issue.path || "<root>")}: ${sanitizeTerminalText(issue.message)}`)
        .join("\n");
}
export function formatInvalidConfigLogMessage(configPath, details) {
    return `Invalid config at ${configPath}:\\n${details}`;
}
export function logInvalidConfigOnce(params) {
    if (params.loggedConfigPaths.has(params.configPath)) {
        return;
    }
    params.loggedConfigPaths.add(params.configPath);
    params.logger.error(formatInvalidConfigLogMessage(params.configPath, params.details));
}
export function createInvalidConfigError(configPath, details) {
    const error = new Error(`Invalid config at ${configPath}:\n${details}`);
    error.code = "INVALID_CONFIG";
    error.details = details;
    return error;
}
export function throwInvalidConfig(params) {
    const details = formatInvalidConfigDetails(params.issues);
    logInvalidConfigOnce({
        configPath: params.configPath,
        details,
        logger: params.logger,
        loggedConfigPaths: params.loggedConfigPaths,
    });
    throw createInvalidConfigError(params.configPath, details);
}
