export function createPluginLoaderLogger(logger) {
    return {
        info: (msg) => logger.info(msg),
        warn: (msg) => logger.warn(msg),
        error: (msg) => logger.error(msg),
        debug: (msg) => logger.debug?.(msg),
    };
}
